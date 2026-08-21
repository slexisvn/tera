import {
  irBranch,
  irCallBuiltin,
  irConstant,
  irGenericAdd,
  irInt32Add,
  irInt32Compare,
  irJump,
  irLoadElement,
  namespaceCallArguments,
  type CFGBlock,
  type CFGFunction,
  type CFGInstruction,
} from "../ir/index.js";
import { addPhi, connect, link, splitBlockBefore } from "../ir/cfg-edit.js";
import { GraphEditor } from "../ir/editor.js";
import { nodeIdStamper } from "../ir/graph-edit.js";
import {
  builtinMethodCallMetadata,
  builtinMethodIntrinsicFor,
} from "../metadata/builtin-methods.js";
import {
  ARRAY_LENGTH_OFFSET,
  type ClassShape,
  type ClassTable,
} from "../metadata/class-table.js";
import { stringType, TypeKind, type LatticeType } from "../types/lattice.js";
import { nominalLatticeType } from "../types/declared.js";
import type { TypeInference } from "../analyses/type-inference.js";
import {
  arrayModelOf,
  elementAccess,
  loadBuffer,
  loadCount,
  type ArrayModel,
} from "./array-shapes.js";
import { fieldLoadNode } from "./class-member-lowering.js";
import { append, constantAt, type Stamp } from "./guards.js";

const JSON_NAMESPACE = "JSON";
const STRINGIFY_MEMBER = "stringify";
const REPLACE_MEMBER = "replace_all";
const ONE_SUBJECT = 1;
const FIRST_INDEX = 0;
const STEP = 1;
const LESS_THAN = "<";
const EQUALS = "==";

const QUOTE = '"';
const OBJECT_OPEN = "{";
const OBJECT_CLOSE = "}";
const ARRAY_OPEN = "[";
const ARRAY_CLOSE = "]";
const SEPARATOR = ",";
const PAIRING = ":";
const EMPTY = "";
const NOTHING = "null";

const ESCAPES: readonly (readonly [string, string])[] = [
  ["\\", "\\\\"],
  ['"', '\\"'],
  ["\n", "\\n"],
  ["\r", "\\r"],
  ["\t", "\\t"],
];

type Emit = (node: CFGInstruction) => CFGInstruction;

class Rendering {
  private readonly editor: GraphEditor;
  private readonly stamp: Stamp;
  private readonly visiting = new Set<number>();

  constructor(
    private readonly graph: CFGFunction,
    private readonly node: CFGInstruction,
    private readonly classes: ClassTable,
    private readonly types: TypeInference,
  ) {
    this.editor = new GraphEditor(graph);
    this.stamp = nodeIdStamper(graph);
  }

  get ahead(): Emit {
    return (added) => {
      added.frameState ??= this.node.frameState;
      this.editor.insertBefore(this.node, this.stamp(added));
      return added;
    };
  }

  private into(block: CFGBlock): Emit {
    return (added) => {
      added.frameState ??= this.node.frameState;
      return append(block, added, this.stamp);
    };
  }

  private text(emit: Emit, value: string): CFGInstruction {
    return emit(irConstant(value));
  }

  private joined(emit: Emit, left: CFGInstruction, right: CFGInstruction): CFGInstruction {
    return emit(irGenericAdd(left, right));
  }

  private wrapped(
    emit: Emit,
    open: string,
    body: CFGInstruction,
    close: string,
  ): CFGInstruction {
    const opened = this.joined(emit, this.text(emit, open), body);
    return this.joined(emit, opened, this.text(emit, close));
  }

  private stringMethod(
    emit: Emit,
    member: string,
    args: readonly CFGInstruction[],
  ): CFGInstruction {
    const intrinsic = builtinMethodIntrinsicFor(stringType(), member)!;
    return emit(
      irCallBuiltin(intrinsic.qualifiedName, [...args], builtinMethodCallMetadata(intrinsic)),
    );
  }

  private escaped(emit: Emit, value: CFGInstruction): CFGInstruction {
    let carried = value;
    for (const [from, to] of ESCAPES) {
      carried = this.stringMethod(emit, REPLACE_MEMBER, [
        carried,
        this.text(emit, from),
        this.text(emit, to),
      ]);
    }
    return carried;
  }

  private spelled(emit: Emit, value: CFGInstruction): CFGInstruction {
    return this.joined(emit, value, this.text(emit, EMPTY));
  }

  private objectShape(type: LatticeType): ClassShape | null {
    if (type.kind !== TypeKind.Object || typeof type.map !== "number") return null;
    const shape = this.classes.shapeById(type.map);
    if (shape === null || shape.unsupported.length > 0) return null;
    return this.classes.arrayLayoutOf(shape) === null ? shape : null;
  }

  private renderObject(
    emit: Emit,
    value: CFGInstruction,
    shape: ClassShape,
  ): CFGInstruction | null {
    if (this.visiting.has(shape.id)) return null;
    this.visiting.add(shape.id);
    let body: CFGInstruction | null = null;
    for (const field of shape.fields.values()) {
      const read = emit(fieldLoadNode(value, field, this.classes));
      const rendered = this.render(
        emit,
        read,
        nominalLatticeType(field.declaredType, this.classes),
      );
      if (rendered === null) {
        this.visiting.delete(shape.id);
        return null;
      }
      const label = this.text(emit, `${body === null ? EMPTY : SEPARATOR}${QUOTE}${field.name}${QUOTE}${PAIRING}`);
      const pair = this.joined(emit, label, rendered);
      body = body === null ? pair : this.joined(emit, body, pair);
    }
    this.visiting.delete(shape.id);
    if (body === null) return this.text(emit, `${OBJECT_OPEN}${OBJECT_CLOSE}`);
    return this.wrapped(emit, OBJECT_OPEN, body, OBJECT_CLOSE);
  }

  private renderArray(value: CFGInstruction, model: ArrayModel): CFGInstruction | null {
    const length = loadCount(this.editor, this.node, value, ARRAY_LENGTH_OFFSET, model, this.stamp);
    const buffer = loadBuffer(this.editor, this.node, value, model, this.stamp);
    const origin = constantAt(this.editor, this.node, FIRST_INDEX, this.stamp);
    const step = constantAt(this.editor, this.node, STEP, this.stamp);
    const blank = this.text(this.ahead, EMPTY);
    const comma = this.text(this.ahead, SEPARATOR);

    const entry = this.node.block!;
    const after = splitBlockBefore(this.graph, entry, this.node);
    const header = this.graph.addBlock();
    const body = this.graph.addBlock();
    const leading = this.graph.addBlock();
    const between = this.graph.addBlock();
    const merge = this.graph.addBlock();

    append(entry, irJump(header), this.stamp);
    link(entry, header);

    const cursor = this.stamp(addPhi(header, [origin]));
    const carried = this.stamp(addPhi(header, [blank]));
    const more = append(header, irInt32Compare(LESS_THAN, cursor, length), this.stamp);
    append(header, irBranch(more, body, after), this.stamp);
    link(header, body);
    link(header, after);

    const first = append(body, irInt32Compare(EQUALS, cursor, origin), this.stamp);
    append(body, irBranch(first, leading, between), this.stamp);
    link(body, leading);
    link(body, between);
    append(leading, irJump(merge), this.stamp);
    append(between, irJump(merge), this.stamp);
    const spacing = this.stamp(addPhi(merge));
    connect(leading, merge, [blank]);
    connect(between, merge, [comma]);

    const closing = append(merge, irJump(header), this.stamp);
    const element = elementAccess(
      this.editor,
      closing,
      irLoadElement(buffer, cursor),
      model,
      this.stamp,
    );
    const rendered = this.render(
      (added) => {
        added.frameState ??= this.node.frameState;
        this.editor.insertBefore(closing, this.stamp(added));
        return added;
      },
      element,
      nominalLatticeType(model.declaredType, this.classes),
    );
    if (rendered === null) return null;
    const separated = this.stamp(irGenericAdd(carried, spacing));
    this.editor.insertBefore(closing, separated);
    const grown = this.stamp(irGenericAdd(separated, rendered));
    this.editor.insertBefore(closing, grown);
    const next = this.stamp(irInt32Add(cursor, step));
    next.props.noOverflow = true;
    this.editor.insertBefore(closing, next);
    link(merge, header);
    cursor.addInput(next);
    carried.addInput(grown);

    return this.wrapped(this.ahead, ARRAY_OPEN, carried, ARRAY_CLOSE);
  }

  render(emit: Emit, value: CFGInstruction, type: LatticeType): CFGInstruction | null {
    if (type.kind === TypeKind.String) {
      return this.wrapped(emit, QUOTE, this.escaped(emit, value), QUOTE);
    }
    if (
      type.kind === TypeKind.Smi ||
      type.kind === TypeKind.Double ||
      type.kind === TypeKind.Number ||
      type.kind === TypeKind.Boolean
    ) {
      return this.spelled(emit, value);
    }
    if (type.kind === TypeKind.Nullish) return this.text(emit, NOTHING);
    const shape = this.objectShape(type);
    if (shape !== null) return this.renderObject(emit, value, shape);
    const model = arrayModelOf(value, this.graph, this.classes, this.types);
    return model === null ? null : this.renderArray(value, model);
  }
}

function stringifiedValue(node: CFGInstruction): CFGInstruction | null {
  const args = namespaceCallArguments(node, JSON_NAMESPACE, STRINGIFY_MEMBER);
  return args?.length === ONE_SUBJECT ? args[0]! : null;
}

export function lowerJsonSurface(graph: CFGFunction, types: TypeInference): number {
  const classes = graph.classes;
  if (classes === null) return 0;
  let lowered = 0;
  const attempted = new Set<CFGInstruction>();
  for (let index = 0; index < graph.blocks.length; index += 1) {
    const block = graph.blocks[index]!;
    for (const node of [...block.nodes]) {
      if (node.block !== block || attempted.has(node)) continue;
      const subject = stringifiedValue(node);
      if (subject === null) continue;
      attempted.add(node);
      const rendering = new Rendering(graph, node, classes, types);
      const rendered = rendering.render(rendering.ahead, subject, types.typeOf(subject));
      if (rendered === null) continue;
      const editor = new GraphEditor(graph);
      editor.replaceAllUses(node, rendered);
      editor.remove(node);
      lowered += 1;
    }
  }
  if (lowered > 0) graph.rebuildUses();
  return lowered;
}
