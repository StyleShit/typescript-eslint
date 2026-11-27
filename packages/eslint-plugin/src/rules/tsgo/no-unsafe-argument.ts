import type { TSESTree } from '@typescript-eslint/utils';

import { AST_NODE_TYPES, ESLintUtils } from '@typescript-eslint/utils';

import type { MessageIds } from '../no-unsafe-argument';

import { containsAnyEach, filterListener } from './utils';

type Create = ESLintUtils.RuleCreateWithOptions<[], MessageIds>;

type CallLike =
  | TSESTree.CallExpression
  | TSESTree.NewExpression
  | TSESTree.TaggedTemplateExpression;

/**
 * The tsgo implementation of `no-unsafe-argument`.
 *
 * The rule resolves every call's signature and parameter types before
 * comparing arguments, several round trips per call through the adapters.
 * Yet `isUnsafeAssignment` only flags an argument whose type is `any` or has
 * `any` among its type arguments. Here the argument types of the whole file
 * are checked for that in a few batched requests, and only the calls that
 * pass (or spread an argument) reach the rule's own listeners.
 */
export function createTsgo(createDefault: Create): Create {
  return (context, options) => {
    const { api, checker, getNativeNode } =
      ESLintUtils.getNativeParserServices(context).native;

    function mayReport(nodes: readonly CallLike[]): boolean[] {
      const argumentLists = nodes.map(node =>
        node.type === AST_NODE_TYPES.TaggedTemplateExpression
          ? node.quasi.expressions
          : node.arguments,
      );
      const spreads = argumentLists.map(list =>
        list.some(argument => argument.type === AST_NODE_TYPES.SpreadElement),
      );
      const checked = argumentLists.flatMap((list, index) =>
        spreads[index] ? [] : list,
      );
      const unsafe = new Map<TSESTree.Node, boolean>();
      if (checked.length) {
        const types = checker.getTypeAtLocation(checked.map(getNativeNode));
        containsAnyEach(api, checker, types).forEach((result, index) =>
          unsafe.set(checked[index], result),
        );
      }
      return argumentLists.map(
        (list, index) =>
          spreads[index] || list.some(argument => unsafe.get(argument)),
      );
    }

    let listeners = createDefault(context, options);
    for (const selector of [
      'CallExpression, NewExpression',
      AST_NODE_TYPES.TaggedTemplateExpression,
    ]) {
      listeners = filterListener(listeners, selector, mayReport);
    }
    return listeners;
  };
}
