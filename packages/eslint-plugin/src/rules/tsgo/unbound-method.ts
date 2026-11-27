import type { TSESTree } from '@typescript-eslint/utils';

import { AST_NODE_TYPES, ESLintUtils } from '@typescript-eslint/utils';
import { SyntaxKind } from '@typescript/native/ast';

import type { MessageIds, Options } from '../unbound-method';

import { isSafeUse } from '../unbound-method';
import {
  batchEach,
  distinct,
  filterListener,
  getIntersectionConstituents,
  getUnionConstituents,
} from './utils';

type Create = ESLintUtils.RuleCreateWithOptions<Options, MessageIds>;

/** The declarations `checkIfMethod` can consider dangerous. */
const METHOD_LIKE_KINDS = new Set<number>([
  SyntaxKind.MethodDeclaration,
  SyntaxKind.MethodSignature,
  SyntaxKind.PropertyAssignment,
  SyntaxKind.PropertyDeclaration,
]);

/**
 * The tsgo implementation of `unbound-method`.
 *
 * For each member access that isn't called, the rule asks after the object's
 * symbol, its type, built-in-ness and the property per constituent, one round
 * trip per step through the adapters. It only reports a property declared as
 * a method, or as a property that may hold a function expression. Here those
 * declarations are looked up for every member access of the file in a few
 * batched requests, and only accesses that may name one reach the rule's own
 * `MemberExpression` listener. Destructuring is checked unchanged.
 */
export function createTsgo(createDefault: Create): Create {
  return (context, options) => {
    const { api, checker, getNativeNode } =
      ESLintUtils.getNativeParserServices(context).native;

    function mayReport(nodes: readonly TSESTree.MemberExpression[]): boolean[] {
      // Computed names need the property's type, so the rule checks them itself.
      const results = nodes.map(node => !isSafeUse(node) && node.computed);
      const named = nodes.flatMap((node, index) =>
        !isSafeUse(node) &&
        !node.computed &&
        node.property.type === AST_NODE_TYPES.Identifier
          ? [{ index, name: node.property.name, object: node.object }]
          : [],
      );
      if (!named.length) {
        return results;
      }
      const objectTypes = checker.getTypeAtLocation(
        named.map(({ object }) => getNativeNode(object)),
      );
      const unionParts = getUnionConstituents(api, objectTypes);
      const flatUnionParts = distinct(unionParts.flat());
      const intersectionLists = getIntersectionConstituents(
        api,
        flatUnionParts,
      );
      const intersectionParts = new Map(
        flatUnionParts.map((part, index) => [
          part.id,
          intersectionLists[index],
        ]),
      );
      const lookups = named.flatMap(({ name }, namedIndex) =>
        unionParts[namedIndex]
          .flatMap(part => intersectionParts.get(part.id) ?? [])
          .map(part => ({ name, namedIndex, part })),
      );
      const properties = batchEach(api, lookups, ({ name, part }) =>
        part.getProperty.gen(name),
      );
      lookups.forEach(({ namedIndex }, lookupIndex) => {
        const kind = properties[lookupIndex]?.valueDeclaration?.kind;
        if (kind != null && METHOD_LIKE_KINDS.has(kind)) {
          results[named[namedIndex].index] = true;
        }
      });
      return results;
    }

    return filterListener(
      createDefault(context, options),
      AST_NODE_TYPES.MemberExpression,
      mayReport,
    );
  };
}
