// Existing unit fixtures pass a source-root string and build an explicit
// <source>/runtime tree. Production entrypoints always pass a context object;
// this test-only switch keeps those legacy fixtures isolated while dedicated
// JEA Home tests exercise the production default.
globalThis.__JEA_TEST_LEGACY_ROOT_ARGUMENT__ = true;
process.env.JEA_TEST_LEGACY_ROOT_ARGUMENT = '1';
