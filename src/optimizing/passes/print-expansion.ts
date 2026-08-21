import {
  IR_CALL_BUILTIN,
  IR_CONSTANT,
  irBranch,
  irCallBuiltin,
  irConstant,
  irInt32Add,
  irInt32Compare,
  irJump,
  irLoadElement,
  irLoadField,
  irLoadText,
  type CFGBlock,
  type CFGFunction,
  type CFGInstruction,
} from "../ir/index.js";
import { addPhi, link, splitBlockBefore } from "../ir/cfg-edit.js";
import { GraphEditor } from "../ir/editor.js";
import { nodeIdStamper } from "../ir/graph-edit.js";
import type { TypeInference } from "../analyses/type-inference.js";
import {
  ARRAY_LENGTH_OFFSET,
  CLASS_ID_PROP,
  FIELD_SCALAR_PROP,
  FIELD_TYPE_PROP,
  VALUE_CLASS_PROP,
  type ClassField,
  type ClassShape,
  type ClassTable,
} from "../metadata/class-table.js";
import {
  AGGREGATE_CLOSE_TEXT,
  AGGREGATE_OPEN_TEXT,
  AGGREGATE_SEPARATOR_TEXT,
  builtinGlobalIntrinsicByName,
  builtinMethodCallMetadata,
  NO_TERMINATOR,
  OBJECT_CLOSE_TEXT,
  OBJECT_OPEN_TEXT,
  PRINT_BUILTIN,
  PRINT_TERMINATOR_PROP,
  printTerminatorAt,
} from "../metadata/builtin-methods.js";
import { NULL_TEXT } from "../metadata/printed-values.js";
import { TypeKind } from "../types/lattice.js";
import { SCALAR_TEXT, scalarWidth } from "../types/scalar.js";
import {
  arrayModelForDeclaredType,
  arrayModelOf,
  describeElement,
  loadBuffer,
  loadCount,
  type ArrayModel,
} from "./array-shapes.js";

const EQUALS = "==";
const LESS_THAN = "<";
const FIRST_INDEX = 0;
const STEP = 1;
const FIELD_SEPARATOR = ": ";

type Stamp = (node: CFGInstruction) => CFGInstruction;

class PrintExpander {
  private readonly editor: GraphEditor;
  private readonly stamp: Stamp;
  private readonly visiting = new Set<number>();
  count = 0;

  constructor(
    private readonly graph: CFGFunction,
    private readonly classes: ClassTable,
    private readonly types: TypeInference,
  ) {
    this.editor = new GraphEditor(graph);
    this.stamp = nodeIdStamper(graph);
  }

  run(): number {
    for (const block of this.graph.blocks) {
      for (const node of [...block.nodes]) {
        if (node.block !== block || !this.expandable(node)) continue;
        this.expand(node);
        this.count++;
      }
    }
    if (this.count > 0) this.graph.rebuildUses();
    return this.count;
  }

  private expandable(node: CFGInstruction): boolean {
    if (node.type !== IR_CALL_BUILTIN || String(node.props.name) !== PRINT_BUILTIN) return false;
    if (node.props[PRINT_TERMINATOR_PROP] !== undefined) return false;
    return node.inputs.some((value) => this.aggregateOf(value) !== null || this.isNull(value));
  }

  private isNull(value: CFGInstruction): boolean {
    return value.type === IR_CONSTANT && value.props.value === null;
  }

  private expand(node: CFGInstruction): void {
    const arity = node.inputs.length;
    node.inputs.forEach((value, index) => {
      this.emitValue(node, value, printTerminatorAt(index, arity));
    });
    this.editor.remove(node);
  }

  private shapeOf(value: CFGInstruction): ClassShape | null {
    const type = this.types.typeOf(value);
    if (type.kind === TypeKind.Object && type.map !== null) {
      const shaped = this.classes.shapeById(Number(type.map));
      if (shaped !== null) return shaped;
    }
    const carried = value.props[VALUE_CLASS_PROP];
    return typeof carried === "number" ? this.classes.shapeById(carried) : null;
  }

  private arrayOf(value: CFGInstruction): ArrayModel | null {
    return (
      arrayModelOf(value, this.graph, this.classes, this.types) ??
      arrayModelForDeclaredType(value.props[FIELD_TYPE_PROP] as string, this.classes)
    );
  }

  private aggregateOf(value: CFGInstruction): ArrayModel | ClassShape | null {
    const model = this.arrayOf(value);
    if (model !== null) return this.visiting.has(model.shape.id) ? null : model;
    const shape = this.shapeOf(value);
    if (shape === null || this.visiting.has(shape.id)) return null;
    return this.classes.arrayLayoutOf(shape) === null ? shape : null;
  }

  private insert(anchor: CFGInstruction, node: CFGInstruction): CFGInstruction {
    this.stamp(node);
    this.editor.insertBefore(anchor, node);
    return node;
  }

  private constant(anchor: CFGInstruction, value: number | string): CFGInstruction {
    return this.insert(anchor, irConstant(value));
  }

  private emitPrint(
    anchor: CFGInstruction,
    value: CFGInstruction,
    terminator: number,
  ): void {
    const intrinsic = builtinGlobalIntrinsicByName(PRINT_BUILTIN)!;
    const call = irCallBuiltin(PRINT_BUILTIN, [value], builtinMethodCallMetadata(intrinsic));
    call.props[PRINT_TERMINATOR_PROP] = terminator;
    call.frameState = anchor.frameState;
    this.insert(anchor, call);
  }

  private emitText(anchor: CFGInstruction, text: string, terminator: number): void {
    this.emitPrint(anchor, this.constant(anchor, text), terminator);
  }

  private emitValue(
    anchor: CFGInstruction,
    value: CFGInstruction,
    terminator: number,
  ): void {
    const aggregate = this.aggregateOf(value);
    if (aggregate === null) {
      if (this.isNull(value)) {
        this.emitText(anchor, NULL_TEXT, terminator);
        return;
      }
      this.emitPrint(anchor, value, terminator);
      return;
    }
    if ("element" in aggregate) {
      this.emitElements(anchor, value, aggregate, terminator);
      return;
    }
    this.emitFields(anchor, value, aggregate, terminator);
  }

  private fieldValue(
    anchor: CFGInstruction,
    receiver: CFGInstruction,
    field: ClassField,
  ): CFGInstruction {
    const inline = field.scalar === SCALAR_TEXT;
    const load = inline
      ? irLoadText(receiver, field.offset, scalarWidth(SCALAR_TEXT), field.name)
      : irLoadField(receiver, field.offset);
    load.props[CLASS_ID_PROP] = this.classes.shapeIdOf(field.owner);
    load.props[FIELD_TYPE_PROP] = field.declaredType;
    load.props[FIELD_SCALAR_PROP] = field.scalar;
    const held = this.classes.shapeOf(field.declaredType);
    if (held !== null) load.props[VALUE_CLASS_PROP] = held.id;
    load.frameState = anchor.frameState;
    return this.insert(anchor, load);
  }

  private emitFields(
    anchor: CFGInstruction,
    receiver: CFGInstruction,
    shape: ClassShape,
    terminator: number,
  ): void {
    this.visiting.add(shape.id);
    this.emitText(anchor, OBJECT_OPEN_TEXT, NO_TERMINATOR);
    let written = 0;
    for (const field of shape.fields.values()) {
      if (written > 0) this.emitText(anchor, AGGREGATE_SEPARATOR_TEXT, NO_TERMINATOR);
      this.emitText(anchor, `${field.name}${FIELD_SEPARATOR}`, NO_TERMINATOR);
      this.emitValue(anchor, this.fieldValue(anchor, receiver, field), NO_TERMINATOR);
      written++;
    }
    this.emitText(anchor, OBJECT_CLOSE_TEXT, terminator);
    this.visiting.delete(shape.id);
  }

  private emitElements(
    anchor: CFGInstruction,
    array: CFGInstruction,
    model: ArrayModel,
    terminator: number,
  ): void {
    this.visiting.add(model.shape.id);
    this.emitText(anchor, AGGREGATE_OPEN_TEXT, NO_TERMINATOR);

    const length = loadCount(this.editor, anchor, array, ARRAY_LENGTH_OFFSET, model, this.stamp);
    const buffer = loadBuffer(this.editor, anchor, array, model, this.stamp);
    const start = this.constant(anchor, FIRST_INDEX);
    const step = this.constant(anchor, STEP);

    const entry = anchor.block!;
    const after = splitBlockBefore(this.graph, entry, anchor);
    const header = this.graph.addBlock();
    const body = this.graph.addBlock();
    const between = this.graph.addBlock();
    const merged = this.graph.addBlock();
    const advance = this.graph.addBlock();

    this.append(entry, irJump(header));
    link(entry, header);

    const cursor = this.stamp(addPhi(header, [start]));
    const more = this.append(header, irInt32Compare(LESS_THAN, cursor, length));
    this.append(header, irBranch(more, body, after));
    link(header, body);
    link(header, after);

    const first = this.append(body, irInt32Compare(EQUALS, cursor, start));
    this.append(body, irBranch(first, merged, between));
    link(body, merged);
    link(body, between);

    const carry = this.append(between, irJump(merged));
    this.emitText(carry, AGGREGATE_SEPARATOR_TEXT, NO_TERMINATOR);
    link(between, merged);

    const closing = this.append(merged, irJump(advance));
    const element = this.insert(closing, this.elementLoad(buffer, cursor, model, anchor));
    this.emitValue(closing, element, NO_TERMINATOR);
    link(closing.block!, advance);

    const next = this.append(advance, irInt32Add(cursor, step));
    next.props.noOverflow = true;
    this.append(advance, irJump(header));
    link(advance, header);
    cursor.addInput(next);

    this.emitText(anchor, AGGREGATE_CLOSE_TEXT, terminator);
    this.visiting.delete(model.shape.id);
  }

  private elementLoad(
    buffer: CFGInstruction,
    cursor: CFGInstruction,
    model: ArrayModel,
    anchor: CFGInstruction,
  ): CFGInstruction {
    const load = irLoadElement(buffer, cursor);
    describeElement(load, model);
    load.props.elementRep = model.element;
    const held = this.classes.shapeOf(model.declaredType);
    if (held !== null) load.props[VALUE_CLASS_PROP] = held.id;
    load.frameState = anchor.frameState;
    return load;
  }

  private append(block: CFGBlock, node: CFGInstruction): CFGInstruction {
    this.stamp(node);
    node.block = block;
    block.nodes.push(node);
    return node;
  }
}

export function expandAggregatePrints(graph: CFGFunction, types: TypeInference): number {
  const classes = graph.classes;
  if (classes === null) return 0;
  return new PrintExpander(graph, classes, types).run();
}
