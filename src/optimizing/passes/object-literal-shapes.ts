import {
  IR_GENERIC_SET_PROP,
  IR_NEW_OBJECT,
  IR_RETURN,
  type CFGFunction,
  type CFGInstruction,
} from "../ir/index.js";
import { CLASS_DATA_MEMBER } from "../../core/class-member.js";
import type { ClassMemberSurface, ClassSurface } from "../../frontend/modules/interface.js";
import { declaredTypeOf, type ClassTable } from "../metadata/class-table.js";
import type { TypeInference } from "../analyses/type-inference.js";
import { TypeKind, type LatticeType } from "../types/lattice.js";
import { CLASS_ID_PROP, INSTANCE_SIZE_PROP, VALUE_CLASS_PROP } from "./class-member-lowering.js";

const LITERAL_SHAPE_PREFIX = "tera_literal";
const ANY_TYPE = "any";

interface LiteralField {
  readonly name: string;
  readonly declaredType: string;
}

function member(owner: string, field: LiteralField): ClassMemberSurface {
  return {
    name: field.name,
    declaredType: field.declaredType,
    member: CLASS_DATA_MEMBER,
    owner,
    abstract: false,
    visibility: "public",
    static: false,
  };
}

function surfaceOf(name: string, fields: readonly LiteralField[]): ClassSurface {
  return {
    name,
    parent: null,
    abstract: false,
    members: fields.map((field) => member(name, field)),
    constructorParams: [],
    constructorParamNames: [],
  };
}

function shapeNameOf(fields: readonly LiteralField[]): string {
  const layout = fields.map((field) => `${field.name}_${field.declaredType}`).join("$");
  return `${LITERAL_SHAPE_PREFIX}$${layout}`;
}

function initializerOf(
  allocation: CFGInstruction,
  classes: ClassTable,
  types: TypeInference,
): readonly LiteralField[] | null {
  const block = allocation.block;
  if (block === null) return null;
  const fields: LiteralField[] = [];
  const named = new Map<string, string>();
  for (const use of allocation.uses) {
    if (use.type !== IR_GENERIC_SET_PROP || use.inputs[0] !== allocation) continue;
    const name = String(use.props.propName);
    const stored = use.inputs[1];
    if (stored === undefined) return null;
    const declaredType = declaredTypeOf(types.typeOf(stored), classes);
    if (declaredType === null) return null;
    const seen = named.get(name);
    if (seen !== undefined) {
      if (seen !== declaredType) return null;
      continue;
    }
    named.set(name, declaredType);
    fields.push({ name, declaredType });
  }
  return fields.length === 0 ? null : fields;
}

export function literalReturnShapeOf(graph: CFGFunction): string | null {
  const declared = graph.declaredSignature?.returns ?? null;
  if (declared !== null && declared !== ANY_TYPE) return null;
  let shaped: string | null = null;
  for (const block of graph.blocks) {
    for (const node of block.nodes) {
      if (node.type !== IR_RETURN) continue;
      const returned = node.inputs[0];
      const carried = returned?.props[VALUE_CLASS_PROP];
      const name =
        typeof carried === "number" ? graph.classes?.shapeById(carried)?.name ?? null : null;
      if (name === null || !name.startsWith(`${LITERAL_SHAPE_PREFIX}$`)) return null;
      if (shaped !== null && shaped !== name) return null;
      shaped = name;
    }
  }
  return shaped;
}

export function shapeObjectLiterals(graph: CFGFunction, types: TypeInference): number {
  const classes = graph.classes;
  if (classes === null) return 0;
  let shaped = 0;
  for (const block of graph.blocks) {
    for (const node of block.nodes) {
      if (node.type !== IR_NEW_OBJECT) continue;
      if (node.props[CLASS_ID_PROP] !== undefined) continue;
      const fields = initializerOf(node, classes, types);
      if (fields === null) continue;
      const shape = classes.defineSynthetic(surfaceOf(shapeNameOf(fields), fields));
      if (shape.fields.size !== fields.length) continue;
      node.props[CLASS_ID_PROP] = shape.id;
      node.props[INSTANCE_SIZE_PROP] = shape.size;
      node.props[VALUE_CLASS_PROP] = shape.id;
      shaped++;
    }
  }
  return shaped;
}
