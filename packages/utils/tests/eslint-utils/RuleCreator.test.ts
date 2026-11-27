import { ESLintUtils } from '../../src';

describe(ESLintUtils.RuleCreator, () => {
  interface TestDocs {
    recommended?: 'yes';
  }

  const createRule = ESLintUtils.RuleCreator<TestDocs>(name => `test/${name}`);

  it('createRule should be a function', () => {
    expect(createRule).toBeTypeOf('function');
  });

  it('should create rule correctly', () => {
    const rule = createRule({
      create() {
        return {};
      },
      meta: {
        docs: {
          description: 'some description',
          dialects: ['JavaScript', 'TypeScript'],
          recommended: 'yes',
        },
        languages: ['js/js', 'markdown/gfm'],
        messages: {
          foo: 'some message',
        },
        schema: [],
        type: 'problem',
      },
      name: 'test',
    });
    expect(rule.meta).toEqual({
      docs: {
        description: 'some description',
        dialects: ['JavaScript', 'TypeScript'],
        recommended: 'yes',
        url: 'test/test',
      },
      languages: ['js/js', 'markdown/gfm'],
      messages: {
        foo: 'some message',
      },
      schema: [],
      type: 'problem',
    });
    expect(rule.name).toBe('test');
  });

  it('withoutDocs should work without a `name`', () => {
    const rule = ESLintUtils.RuleCreator.withoutDocs({
      create() {
        return {};
      },
      meta: {
        docs: {
          description: 'some description',
        },
        messages: {
          foo: 'some message',
        },
        schema: [],
        type: 'problem',
      },
    });

    expect(rule.meta.docs).toEqual({
      description: 'some description',
    });
    expect(rule.name).toBeUndefined();
  });

  it('when defaultOptions is specified, it returns the defaultOptions', () => {
    const rule = createRule({
      create() {
        return {};
      },
      // eslint-disable-next-line @typescript-eslint/no-deprecated -- For compatibility with ESLint 8, see #12842
      defaultOptions: [{ option: true }],
      meta: {
        docs: {
          description: 'some description',
          recommended: 'yes',
        },
        messages: {
          foo: 'some message',
        },
        schema: [],
        type: 'problem',
      },
      name: 'with-default-options',
    });

    // Keep accepting deprecated defaultOptions for backward compatibility.
    // eslint-disable-next-line @typescript-eslint/no-deprecated
    expect(rule.defaultOptions).toEqual([{ option: true }]);
  });

  it('withoutDocs should work with a `name`', () => {
    const rule = ESLintUtils.RuleCreator.withoutDocs({
      create() {
        return {};
      },
      meta: {
        docs: {
          description: 'some description',
        },
        messages: {
          foo: 'some message',
        },
        schema: [],
        type: 'problem',
      },
      name: 'some-name',
    });

    expect(rule.meta.docs).toEqual({
      description: 'some description',
    });
    expect(rule.name).toBe('some-name');
  });

  describe('backends', () => {
    const meta = {
      docs: { description: 'some description' },
      messages: { foo: 'some message' },
      schema: [],
      type: 'problem',
    } as const;

    function contextFor(backend: string | undefined) {
      return {
        options: [],
        sourceCode: {
          parserServices: backend == null ? {} : { backend },
        },
      } as unknown as Parameters<
        ReturnType<typeof ESLintUtils.RuleCreator.withoutDocs>['create']
      >[0];
    }

    function createBackendRule() {
      const defaultListener = {};
      const tsgoListener = {};
      const create = vi.fn(() => defaultListener);
      const createTsgo = vi.fn(() => tsgoListener);
      const loadTsgo = vi.fn(() => createTsgo);
      const rule = ESLintUtils.RuleCreator.withoutDocs({
        backends: { tsgo: loadTsgo },
        create,
        meta,
      });
      return {
        create,
        createTsgo,
        defaultListener,
        loadTsgo,
        rule,
        tsgoListener,
      };
    }

    it('keeps create a plain function and does not expose backends', () => {
      const { rule } = createBackendRule();

      expect(rule.create).toBeTypeOf('function');
      expect(rule).not.toHaveProperty('backends');
    });

    it.for([['classic'], [undefined]] as const)(
      'runs create when the backend is %s',
      ([backend]) => {
        const { create, defaultListener, loadTsgo, rule } = createBackendRule();

        expect(rule.create(contextFor(backend))).toBe(defaultListener);
        expect(create).toHaveBeenCalledOnce();
        expect(loadTsgo).not.toHaveBeenCalled();
      },
    );

    it('runs the tsgo implementation on tsgo, loading it once', () => {
      const { create, createTsgo, loadTsgo, rule, tsgoListener } =
        createBackendRule();

      expect(rule.create(contextFor('tsgo'))).toBe(tsgoListener);
      expect(rule.create(contextFor('tsgo'))).toBe(tsgoListener);
      expect(loadTsgo).toHaveBeenCalledExactlyOnceWith(create);
      expect(createTsgo).toHaveBeenCalledTimes(2);
      expect(create).not.toHaveBeenCalled();
    });
  });
});
