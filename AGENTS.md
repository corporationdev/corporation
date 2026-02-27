## Quick Reference

- **Format code**: `bun fix`
- **Check for issues**: `bun check`
- **Typecheck**: `bun check-types`

When adding new imports, always add the code that uses the import before or in the same edit as the import statement. Never add an import in isolation — the linter will strip unused imports, causing failures on the next pass.
