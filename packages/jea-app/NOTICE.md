# NOTICE

This package independently reimplements application-shell, workspace-layout,
Settings-overlay, theme-token, and shared Electron/Web renderer *patterns*
described by the Open Science project:

https://github.com/aipoch/open-science

No Open Science source files were copied. In particular, this package does not
include scientific project/session, notebook, preview, connector, search,
side-chat, or update features.

JEA domain semantics (Subject, Channel, evolution, governance) remain JEA-specific.

Third-party runtime dependencies keep their own licenses:

- Tailwind CSS, Lucide, class-variance-authority, clsx, tailwind-merge: MIT
- Radix UI primitives: MIT
- React / React DOM: MIT
- Vite, Vitest, Playwright, axe-core: MIT

shadcn-style primitives in `src/ui/` were written against public Radix APIs and
semantic tokens owned by this package; they are not a vendored copy of the
shadcn/ui repository.
