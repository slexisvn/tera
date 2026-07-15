import { dispatcher } from '../dispatcher/dispatcher.js';

export class SignatureRegistry {
  constructor() {
    this._signatures = new Map();
  }

  register(name, params) {
    this._signatures.set(name, { params });
  }

  lookup(name) {
    if (this._signatures.has(name)) return this._signatures.get(name);
    const handle = dispatcher.findOp(name);
    if (handle?.schema) return this._fromSchema(handle.schema);
    return null;
  }

  _fromSchema(schema) {
    const params = [];
    for (const arg of schema.args) {
      if (arg.isOut) continue;
      params.push({
        name: arg.name || arg.kind,
        kind: arg.kind,
        defaultValue: arg.defaultValue,
        isOptional: arg.defaultValue != null,
      });
    }
    return { params };
  }
}
