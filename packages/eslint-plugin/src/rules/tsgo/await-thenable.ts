import type { TSESTree } from '@typescript-eslint/utils';
import type {
  API,
  APIRequestGenerator,
  Checker,
  Signature,
  Symbol as NativeSymbol,
  Type,
} from '@typescript/native/sync';

import { ESLintUtils } from '@typescript-eslint/utils';
import { TypeFlags } from '@typescript/native/sync';

import type { MessageId, Options } from '../await-thenable';

import { reportNonThenableAwait } from '../await-thenable';

type Create = ESLintUtils.RuleCreateWithOptions<Options, MessageId>;

/**
 * The tsgo implementation of `await-thenable`'s `AwaitExpression` check.
 *
 * Through the compatibility adapters each awaited type walks
 * `isThenableType` one checker request at a time: apparent type, `then`,
 * its type, call signatures, the callback parameter's type and its call
 * signatures. Here the awaits of a file are collected and that walk runs
 * breadth-first in `Program:exit`, so each step is one IPC round trip for
 * the whole file. The rule's other listeners are reused unchanged.
 */
export function createTsgo(createDefault: Create): Create {
  return (context, options) => {
    const { AwaitExpression: _, ...listeners } = createDefault(
      context,
      options,
    );
    const { api, checker, getNativeNode } =
      ESLintUtils.getNativeParserServices(context).native;
    const awaits: TSESTree.AwaitExpression[] = [];

    return {
      ...listeners,
      AwaitExpression(node): void {
        awaits.push(node);
      },
      'Program:exit'(node): void {
        listeners['Program:exit']?.(node);
        if (!awaits.length) {
          return;
        }
        const types = checker.getTypeAtLocation(
          awaits.map(awaitNode => getNativeNode(awaitNode.argument)),
        );
        const neverAwaitable = findNeverAwaitable(api, checker, types);
        awaits.forEach((awaitNode, index) => {
          if (neverAwaitable[index]) {
            reportNonThenableAwait(context, awaitNode);
          }
        });
      },
    };
  };
}

// Type ids are stable within a checker, so whether a type is thenable is shared across files.
const thenableByChecker = new WeakMap<Checker, Map<number, boolean>>();

/** Mirrors `needsToBeAwaited(...) === Awaitable.Never` for each type. */
function findNeverAwaitable(
  api: API,
  checker: Checker,
  types: readonly Type[],
): boolean[] {
  const typeParameters = distinct(
    types.filter(type => type.flags & TypeFlags.TypeParameter),
  );
  const constraints = new Map(
    zip(
      typeParameters.map(type => type.id),
      batchEach(api, typeParameters, type =>
        checker.getBaseConstraintOfType.gen(type),
      ),
    ),
  );
  const constrained = types.map(type =>
    type.flags & TypeFlags.TypeParameter ? constraints.get(type.id) : type,
  );

  let thenable = thenableByChecker.get(checker);
  if (!thenable) {
    thenable = new Map();
    thenableByChecker.set(checker, thenable);
  }
  const known = thenable;
  const unknownTypes = distinct(
    constrained.filter(
      (type): type is Type =>
        type != null &&
        !(type.flags & (TypeFlags.Any | TypeFlags.Unknown)) &&
        !known.has(type.id),
    ),
  );
  const results = areThenable(api, checker, unknownTypes);
  unknownTypes.forEach((type, index) => known.set(type.id, results[index]));

  return constrained.map(
    type =>
      // Unconstrained type parameters, `any` and `unknown` may be awaited.
      type != null &&
      !(type.flags & (TypeFlags.Any | TypeFlags.Unknown)) &&
      !known.get(type.id),
  );
}

/** `tsutils.isThenableType`, one batched request per step for all `types`. */
function areThenable(
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
function getUnionConstituents(
  api: API,
  types: readonly Type[],
): (readonly Type[])[] {
  const unions = [
    ...new Map(
      types.flatMap(type =>
        type.isUnionType() ? [[type.id, type] as const] : [],
      ),
    ).values(),
  ];
  const constituents = new Map(
    zip(
      unions.map(type => type.id),
      batchEach(api, unions, type => type.getTypes.gen()),
    ),
  );
  return types.map(type =>
    type.isUnionType() ? (constituents.get(type.id) ?? []) : [type],
  );
}

function batchEach<Item, Result>(
  api: API,
  items: readonly Item[],
  request: (item: Item) => APIRequestGenerator<Result>,
): Result[] {
  return items.length ? api.batch(...items.map(request)) : [];
}

function distinct(types: readonly Type[]): Type[] {
  return [...new Map(types.map(type => [type.id, type])).values()];
}

function distinctSymbols(symbols: readonly NativeSymbol[]): NativeSymbol[] {
  return [...new Map(symbols.map(symbol => [symbol.id, symbol])).values()];
}

function zip<Key, Value>(
  keys: readonly Key[],
  values: readonly Value[],
): [Key, Value][] {
  return keys.map((key, index) => [key, values[index]]);
}
