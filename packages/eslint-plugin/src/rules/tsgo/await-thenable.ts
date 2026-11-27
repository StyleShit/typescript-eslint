import type { TSESTree } from '@typescript-eslint/utils';
import type { API, Checker, Type } from '@typescript/native/sync';

import { ESLintUtils } from '@typescript-eslint/utils';
import { TypeFlags } from '@typescript/native/sync';

import type { MessageId, Options } from '../await-thenable';

import { reportNonThenableAwait } from '../await-thenable';
import { batchEach, distinct, isThenableEach, zip } from './utils';

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

  const awaitable = constrained.map(
    (type): type is Type =>
      type != null && !(type.flags & (TypeFlags.Any | TypeFlags.Unknown)),
  );
  const candidates = constrained.filter(
    (type, index): type is Type => awaitable[index],
  );
  const thenable = new Map(
    zip(
      candidates.map(type => type.id),
      isThenableEach(api, checker, candidates),
    ),
  );

  // Unconstrained type parameters, `any` and `unknown` may be awaited.
  return constrained.map(
    (type, index) => awaitable[index] && type != null && !thenable.get(type.id),
  );
}
