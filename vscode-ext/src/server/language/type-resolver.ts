import type { Builtin, LanguageData, Method } from "../../shared/language-data.ts";

export type MethodLookup = { ownerName: string; method: Method };

export class TypeResolver {
  private readonly builtinsByName: Map<string, Builtin>;

  constructor(private readonly languageData: LanguageData) {
    this.builtinsByName = new Map(languageData.builtins.map((builtin) => [builtin.name, builtin]));
  }

  builtin(name: string): Builtin | null {
    return this.builtinsByName.get(name) ?? null;
  }

  get builtins(): Builtin[] {
    return this.languageData.builtins;
  }

  pseudoType(name: string): Method[] | null {
    return this.languageData.pseudoTypes[name] ?? null;
  }

  methodsOf(typeName: string | null, seen = new Set<string>()): Method[] {
    if (!typeName || seen.has(typeName)) return [];
    seen.add(typeName);

    const builtin = this.builtin(typeName);
    if (builtin?.methods.length) return builtin.methods;

    const pseudo = this.pseudoType(typeName);
    if (pseudo) return pseudo;

    if (builtin?.returns && builtin.returns !== typeName) {
      return this.methodsOf(builtin.returns, seen);
    }
    return [];
  }

  lookupMethod(typeName: string | null, methodName: string, seen = new Set<string>()): MethodLookup | null {
    if (!typeName || seen.has(typeName)) return null;
    seen.add(typeName);

    const builtin = this.builtin(typeName);
    const own = builtin?.methods.find((method) => method.name === methodName);
    if (own) return { ownerName: typeName, method: own };

    const pseudo = this.pseudoType(typeName)?.find((method) => method.name === methodName);
    if (pseudo) return { ownerName: typeName, method: pseudo };

    if (builtin?.returns && builtin.returns !== typeName) {
      return this.lookupMethod(builtin.returns, methodName, seen);
    }
    return null;
  }

  findUniqueMethod(methodName: string): MethodLookup | null {
    const owners: MethodLookup[] = [];
    for (const [typeName, methods] of Object.entries(this.languageData.pseudoTypes)) {
      const method = methods.find((candidate) => candidate.name === methodName);
      if (method) owners.push({ ownerName: typeName, method });
    }
    return owners.length === 1 ? owners[0] : null;
  }
}
