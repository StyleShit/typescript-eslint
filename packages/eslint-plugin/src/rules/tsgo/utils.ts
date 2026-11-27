import type { TSESLint, TSESTree } from '@typescript-eslint/utils';
import type {
  API,
  APIRequestGenerator,
  Checker,
  Signature,
  Symbol as NativeSymbol,
  Type,
  TypeReference,
  UnionOrIntersectionType,
} from '@typescript/native/sync';

import { TypeFlags } from '@typescript/native/sync';

/*
 * Helpers for rules' tsgo implementations. Each walks a question for many
 * nodes or types at once, one batched IPC request per step, instead of one
 * request per node per step as the classic compatibility adapters do.
 */

/**
 * Defers a stateless listener to `Program:exit`, where `mayReport` checks all
 * of its nodes at once. Only the nodes it can't rule out reach the original
 * listener, so `mayReport` must be sound: false only when the listener
 * would not report.
 */
export function filterListener(
  listeners: TSESLint.RuleListener,
  selector: string,
  // `never[]` so that filters may take the node type their selector matches.
  mayReport: (nodes: readonly never[]) => readonly boolean[],
): TSESLint.RuleListener {
  const listener = listeners[selector] as
    ((node: TSESTree.Node) => void) | undefined;
  if (!listener) {
    return listeners;
  }
  const exit = listeners['Program:exit'];
  const nodes: TSESTree.Node[] = [];
  return {
    ...listeners,
    'Program:exit'(program): void {
      const results = nodes.length ? mayReport(nodes as never[]) : [];
      nodes.forEach((node, index) => {
        if (results[index]) {
          listener(node);
        }
      });
      exit?.(program);
    },
    [selector]: (node: TSESTree.Node) => {
      nodes.push(node);
    },
  };
}

// Type ids are stable within a checker, so whether a type is thenable is shared across files.
const thenableByChecker = new WeakMap<Checker, Map<number, boolean>>();

/** `tsutils.isThenableType` for each type, cached per checker. */
export function isThenableEach(
  api: API,
  checker: Checker,
  types: readonly Type[],
): boolean[] {
  let known = thenableByChecker.get(checker);
  if (!known) {
    known = new Map();
    thenableByChecker.set(checker, known);
  }
  const cache = known;
  const unknownTypes = distinct(types.filter(type => !cache.has(type.id)));
  const results = areThenable(api, checker, unknownTypes);
  unknownTypes.forEach((type, index) => cache.set(type.id, results[index]));
  return types.map(type => cache.get(type.id) === true);
}

/** `tsutils.isThenableType`, one batched request per step for all `types`. */
export function areThenable(
  api: API,
  checker: Checker,
  types: readonly Type[],
): boolean[] {
  if (!types.length) {
    return [];
  }
  const apparentTypes = batchEach(api, types, type =>
    checker.getApparentType.gen(type),
  );
  const apparentParts = getUnionConstituents(api, apparentTypes);

  const parts = distinct(apparentParts.flat());
  const thenSymbols = batchEach(api, parts, part =>
    part.getProperty.gen('then'),
  );
  const thenByPart = new Map(
    zip(
      parts.map(part => part.id),
      thenSymbols,
    ),
  );

  const thens = distinctSymbols(thenSymbols.filter(symbol => symbol != null));
  const thenTypes = thens.length ? checker.getTypeOfSymbol(thens) : [];
  const thenTypeParts = getUnionConstituents(api, thenTypes);

  const signatureOwners = distinct(thenTypeParts.flat());
  const signatures = batchEach(api, signatureOwners, owner =>
    owner.getCallSignatures.gen(),
  );
  const withParameters = [
    ...new Set(
      signatures.flat().filter(signature => signature.parameters.length !== 0),
    ),
  ];
  const callbackBySignature = new Map(
    zip(withParameters, hasCallbackParameter(api, checker, withParameters)),
  );

  const signaturesByOwner = new Map(
    zip(
      signatureOwners.map(owner => owner.id),
      signatures,
    ),
  );
  const thenTypePartsBySymbol = new Map(
    zip(
      thens.map(symbol => symbol.id),
      thenTypeParts,
    ),
  );

  return apparentParts.map(constituents =>
    constituents.some(part => {
      const then = thenByPart.get(part.id);
      return (
        then != null &&
        (thenTypePartsBySymbol.get(then.id) ?? []).some(owner =>
          (signaturesByOwner.get(owner.id) ?? []).some(
            signature => callbackBySignature.get(signature) === true,
          ),
        )
      );
    }),
  );
}

/** `isCallback` from ts-api-utils, applied to each signature's first parameter. */
function hasCallbackParameter(
  api: API,
  checker: Checker,
  signatures: readonly Signature[],
): boolean[] {
  if (!signatures.length) {
    return [];
  }
  const firstParameters = batchEach(api, signatures, signature =>
    signature.getParameters.gen(),
  ).map(parameters => parameters[0]);
  const parameterTypes = checker.getTypeOfSymbol(firstParameters);
  const apparentTypes = batchEach(api, parameterTypes, type =>
    checker.getApparentType.gen(type),
  );

  // A first parameter is a rest parameter only when it is the only one.
  const isRest = signatures.map(
    signature =>
      signature.hasRestParameter && signature.parameters.length === 1,
  );
  const restIndexes = isRest.flatMap((rest, index) => (rest ? [index] : []));
  const elementTypes = batchEach(api, restIndexes, index =>
    apparentTypes[index].getNumberIndexType.gen(),
  );
  const callbackTypes: (Type | undefined)[] = [...apparentTypes];
  restIndexes.forEach((index, restIndex) => {
    callbackTypes[index] = elementTypes[restIndex];
  });

  const present = callbackTypes.filter(type => type != null);
  const presentParts = getUnionConstituents(api, present);
  const owners = distinct(presentParts.flat());
  const signatureCounts = new Map(
    zip(
      owners.map(owner => owner.id),
      batchEach(api, owners, owner => owner.getCallSignatures.gen()).map(
        ownerSignatures => ownerSignatures.length,
      ),
    ),
  );
  const isCallbackType = new Map(
    zip(
      present,
      presentParts.map(parts =>
        parts.some(part => (signatureCounts.get(part.id) ?? 0) !== 0),
      ),
    ),
  );
  return callbackTypes.map(type => type != null && !!isCallbackType.get(type));
}

/** `tsutils.unionConstituents` for each type. */
export function getUnionConstituents(
  api: API,
  types: readonly Type[],
): (readonly Type[])[] {
  return getConstituents(api, types, type => type.isUnionType());
}

/** `tsutils.intersectionConstituents` for each type. */
export function getIntersectionConstituents(
  api: API,
  types: readonly Type[],
): (readonly Type[])[] {
  return getConstituents(api, types, type => type.isIntersectionType());
}

function getConstituents(
  api: API,
  types: readonly Type[],
  isComposite: (type: Type) => type is UnionOrIntersectionType,
): (readonly Type[])[] {
  const composites = [
    ...new Map(
      types.flatMap(type =>
        isComposite(type) ? [[type.id, type] as const] : [],
      ),
    ).values(),
  ];
  const constituents = new Map(
    zip(
      composites.map(type => type.id),
      batchEach(api, composites, type => type.getTypes.gen()),
    ),
  );
  return types.map(type =>
    isComposite(type) ? (constituents.get(type.id) ?? []) : [type],
  );
}

/**
 * Whether each type is `any`, or a type reference with `any` anywhere among
 * its type arguments, at any depth. `isUnsafeAssignment` can only flag such types.
 */
export function containsAnyEach(
  api: API,
  checker: Checker,
  types: readonly Type[],
): boolean[] {
  const results = types.map(type => !!(type.flags & TypeFlags.Any));
  const seen = types.map(() => new Set<number>());
  let frontier = types.flatMap((type, root) =>
    !results[root] && type.isTypeReference() ? [{ root, type }] : [],
  );
  while (frontier.length) {
    const references = distinct(frontier.map(({ type }) => type));
    const argumentsById = new Map(
      zip(
        references.map(type => type.id),
        batchEach(api, references, type =>
          checker.getTypeArguments.gen(type as TypeReference),
        ),
      ),
    );
    const next: typeof frontier = [];
    for (const { root, type } of frontier) {
      for (const argument of argumentsById.get(type.id) ?? []) {
        if (results[root]) {
          break;
        }
        if (argument.flags & TypeFlags.Any) {
          results[root] = true;
        } else if (argument.isTypeReference() && !seen[root].has(argument.id)) {
          seen[root].add(argument.id);
          next.push({ root, type: argument });
        }
      }
    }
    frontier = next.filter(({ root }) => !results[root]);
  }
  return results;
}

/**
 * no-misused-promises' `returnsThenable` for each type: whether a constituent
 * of its apparent type has a call signature returning a thenable.
 */
export function returnsThenableEach(
  api: API,
  checker: Checker,
  types: readonly Type[],
): boolean[] {
  const apparentTypes = batchEach(api, types, type =>
    checker.getApparentType.gen(type),
  );
  const parts = getUnionConstituents(api, apparentTypes);
  const owners = distinct(parts.flat());
  const signatures = batchEach(api, owners, owner =>
    owner.getCallSignatures.gen(),
  );
  const allSignatures = [...new Set(signatures.flat())];
  const returnTypes = batchEach(api, allSignatures, signature =>
    signature.getReturnType.gen(),
  );
  const thenableReturn = new Map(
    zip(allSignatures, isThenableEach(api, checker, returnTypes)),
  );
  const ownerReturnsThenable = new Map(
    zip(
      owners.map(owner => owner.id),
      signatures.map(ownerSignatures =>
        ownerSignatures.some(signature => thenableReturn.get(signature)),
      ),
    ),
  );
  return parts.map(constituents =>
    constituents.some(part => ownerReturnsThenable.get(part.id) === true),
  );
}

export function batchEach<Item, Result>(
  api: API,
  items: readonly Item[],
  request: (item: Item) => APIRequestGenerator<Result>,
): Result[] {
  return items.length ? api.batch(...items.map(request)) : [];
}

export function distinct(types: readonly Type[]): Type[] {
  return [...new Map(types.map(type => [type.id, type])).values()];
}

export function distinctSymbols(
  symbols: readonly NativeSymbol[],
): NativeSymbol[] {
  return [...new Map(symbols.map(symbol => [symbol.id, symbol])).values()];
}

export function zip<Key, Value>(
  keys: readonly Key[],
  values: readonly Value[],
): [Key, Value][] {
  return keys.map((key, index) => [key, values[index]]);
}
