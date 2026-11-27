import type { TSESTree } from '@typescript-eslint/utils';

import { AST_NODE_TYPES, ESLintUtils } from '@typescript-eslint/utils';

import type { MessageId, Options } from '../no-misused-promises';

import { filterListener, returnsThenableEach } from './utils';

type Create = ESLintUtils.RuleCreateWithOptions<Options, MessageId>;

/**
 * The tsgo implementation of `no-misused-promises`.
 *
 * For `checksVoidReturn.arguments`, the rule walks the signatures and
 * parameters of every call's callee before it looks at the arguments, one
 * round trip per step through the adapters. It only reports an argument that
 * returns a thenable, so here that is checked for every argument of the file
 * in a few batched requests, and only calls with such an argument (or a
 * spread) reach the rule's own listeners. The other checks run unchanged.
 */
export function createTsgo(createDefault: Create): Create {
  return (context, options) => {
    const { api, checker, getNativeNode } =
      ESLintUtils.getNativeParserServices(context).native;

    function mayReport(
      nodes: readonly (TSESTree.CallExpression | TSESTree.NewExpression)[],
    ): boolean[] {
      const spreads = nodes.map(node =>
        node.arguments.some(
          argument => argument.type === AST_NODE_TYPES.SpreadElement,
        ),
      );
      const checked = nodes.flatMap((node, index) =>
        spreads[index] ? [] : node.arguments,
      );
      const thenable = new Map<TSESTree.Node, boolean>();
      if (checked.length) {
        const types = checker.getTypeAtLocation(checked.map(getNativeNode));
        returnsThenableEach(api, checker, types).forEach((result, index) =>
          thenable.set(checked[index], result),
        );
      }
      return nodes.map(
        (node, index) =>
          spreads[index] ||
          node.arguments.some(argument => thenable.get(argument)),
      );
    }

    let listeners = createDefault(context, options);
    for (const selector of [
      AST_NODE_TYPES.CallExpression,
      AST_NODE_TYPES.NewExpression,
    ]) {
      listeners = filterListener(listeners, selector, mayReport);
    }
    return listeners;
  };
}
