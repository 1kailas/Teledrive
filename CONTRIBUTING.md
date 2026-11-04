# Contributing to TeleDrive

Thank you for your interest in contributing to **TeleDrive**!

## Architecture Overview

TeleDrive is organized into the following components:
- **`winui-desktop/`**: Windows 11 Native WinUI 3 + Windows App SDK + .NET 8 desktop client.
- **`rust-desktop/`**: High-performance Rust daemon with Tokio async streaming and Telegram Bot API proxy.
- **`web/`**: Modern React 19 + Vite 8 + Tailwind v4 Web SPA.
- **`server/`**: Production Fastify 5 + SQLite FTS5 backend.

---

## Development Setup

### Prerequisites
- Node.js ≥ 20.19.2 (or Node 22 LTS)
- .NET 8.0 SDK (for WinUI 3 desktop client)
- Rust 1.80+ (with `x86_64-pc-windows-gnu` or `x86_64-pc-windows-msvc` target for desktop)

### Installing Dependencies
```bash
npm ci
```

### Running in Development
```bash
# Run Fastify server and React Web frontend together
npm run dev

# Run full local mock environment (Mock Bot API + Server + Web)
npm run dev:mock
```

---

## Testing & Quality Assurance

All PRs must pass the test suite, linting, and typecheck before merging.

### Running Tests
```bash
# Run Fastify server and React web tests (95 tests)
npm test

# Run WinUI .NET unit tests (32 tests)
npm run test:desktop
```

### Typecheck & Linting
```bash
npm run typecheck
npm run lint
```

---

## Building Production Packages

```bash
# Build Web SPA and Server
npm run build

# Build WinUI 3 Desktop self-contained x64 package
npm run build:winui

# Build Rust daemon
npm run rust:build
```

---

## Submitting Pull Requests
1. Fork the repository and create your branch from `main`.
2. Ensure all tests and typechecks pass (`npm test && npm run typecheck && npm run lint`).
3. Commit your changes with clear, descriptive commit messages.
4. Open a pull request against `main`.
