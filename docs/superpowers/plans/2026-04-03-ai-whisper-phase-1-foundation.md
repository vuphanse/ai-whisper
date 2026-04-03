# ai-whisper Phase 1 Foundation Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Build the greenfield monorepo foundation for `ai-whisper` with working TypeScript tooling, root developer workflows, and package boundaries for the v1 architecture.

**Architecture:** Phase 1 does not implement broker or provider behavior yet. It creates the root workspace, shared build/test/lint pipeline, and minimal package entry points so later phases can add real functionality without first restructuring the repo.

**Tech Stack:** Node.js, TypeScript, pnpm workspaces, Vitest, ESLint, Prettier

---

## Proposed File Structure

**Root files:**

- Create: `.editorconfig`
- Create: `.gitignore`
- Create: `README.md`
- Create: `eslint.config.mjs`
- Create: `package.json`
- Create: `pnpm-workspace.yaml`
- Create: `prettier.config.mjs`
- Create: `tsconfig.base.json`
- Create: `tsconfig.json`
- Create: `vitest.config.ts`

**Test files:**

- Create: `test/workspace-foundation.test.ts`
- Create: `test/shared-package.test.ts`
- Create: `test/runtime-packages.test.ts`
- Create: `test/readme-smoke.test.ts`

**Package files:**

- Create: `packages/shared/package.json`
- Create: `packages/shared/tsconfig.json`
- Create: `packages/shared/src/index.ts`
- Create: `packages/shared/src/provider-identity.ts`
- Create: `packages/shared/src/endpoint-health.ts`
- Create: `packages/cli/package.json`
- Create: `packages/cli/tsconfig.json`
- Create: `packages/cli/src/index.ts`
- Create: `packages/broker/package.json`
- Create: `packages/broker/tsconfig.json`
- Create: `packages/broker/src/index.ts`
- Create: `packages/companion-core/package.json`
- Create: `packages/companion-core/tsconfig.json`
- Create: `packages/companion-core/src/index.ts`
- Create: `packages/adapter-codex/package.json`
- Create: `packages/adapter-codex/tsconfig.json`
- Create: `packages/adapter-codex/src/index.ts`
- Create: `packages/adapter-claude/package.json`
- Create: `packages/adapter-claude/tsconfig.json`
- Create: `packages/adapter-claude/src/index.ts`

### Task 1: Root Workspace Scaffold

**Files:**
- Create: `test/workspace-foundation.test.ts`
- Create: `package.json`
- Create: `pnpm-workspace.yaml`
- Create: `tsconfig.base.json`
- Create: `tsconfig.json`
- Create: `vitest.config.ts`
- Create: `eslint.config.mjs`
- Create: `prettier.config.mjs`
- Create: `.gitignore`
- Create: `.editorconfig`

- [ ] **Step 1: Write the failing workspace foundation test**

```ts
// test/workspace-foundation.test.ts
import { existsSync, readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";

const root = fileURLToPath(new URL("..", import.meta.url));

describe("workspace foundation", () => {
  it("declares the root workspace scripts and pnpm workspace file", () => {
    const packageJsonPath = resolve(root, "package.json");
    const workspacePath = resolve(root, "pnpm-workspace.yaml");

    expect(existsSync(packageJsonPath)).toBe(true);
    expect(existsSync(workspacePath)).toBe(true);

    const pkg = JSON.parse(readFileSync(packageJsonPath, "utf8")) as {
      scripts?: Record<string, string>;
    };

    expect(pkg.scripts?.build).toBe("pnpm -r --if-present build");
    expect(pkg.scripts?.test).toBe("vitest run");
    expect(pkg.scripts?.typecheck).toBe(
      "tsc --noEmit -p tsconfig.json && pnpm -r --if-present typecheck",
    );
    expect(pkg.scripts?.lint).toBe("eslint .");
  });
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `pnpm exec vitest run test/workspace-foundation.test.ts`
Expected: FAIL because `package.json` and `pnpm-workspace.yaml` do not exist yet

- [ ] **Step 3: Create the root workspace configuration**

```json
// package.json
{
  "name": "ai-whisper",
  "private": true,
  "type": "module",
  "scripts": {
    "build": "pnpm -r --if-present build",
    "test": "vitest run",
    "test:watch": "vitest",
    "typecheck": "tsc --noEmit -p tsconfig.json && pnpm -r --if-present typecheck",
    "lint": "eslint .",
    "format": "prettier --write .",
    "format:check": "prettier --check ."
  },
  "devDependencies": {
    "@eslint/js": "^9.23.0",
    "@types/node": "^22.13.10",
    "eslint": "^9.23.0",
    "globals": "^16.0.0",
    "prettier": "^3.5.3",
    "tsx": "^4.19.2",
    "typescript": "^5.8.3",
    "typescript-eslint": "^8.27.0",
    "vitest": "^3.1.1"
  }
}
```

```yaml
# pnpm-workspace.yaml
packages:
  - "packages/*"
```

```json
// tsconfig.base.json
{
  "compilerOptions": {
    "target": "ES2022",
    "module": "NodeNext",
    "moduleResolution": "NodeNext",
    "lib": ["ES2022"],
    "strict": true,
    "noUncheckedIndexedAccess": true,
    "exactOptionalPropertyTypes": true,
    "verbatimModuleSyntax": true,
    "declaration": true,
    "declarationMap": true,
    "sourceMap": true,
    "skipLibCheck": true
  }
}
```

```json
// tsconfig.json
{
  "extends": "./tsconfig.base.json",
  "compilerOptions": {
    "noEmit": true
  },
  "include": ["test/**/*.ts", "vitest.config.ts"]
}
```

```ts
// vitest.config.ts
import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    environment: "node",
    include: ["test/**/*.test.ts"]
  }
});
```

```js
// eslint.config.mjs
import js from "@eslint/js";
import globals from "globals";
import tseslint from "typescript-eslint";

export default tseslint.config(
  {
    ignores: ["dist/**", "coverage/**", "node_modules/**"]
  },
  js.configs.recommended,
  ...tseslint.configs.recommendedTypeChecked,
  {
    files: ["**/*.ts"],
    languageOptions: {
      globals: {
        ...globals.node
      },
      parserOptions: {
        projectService: true,
        tsconfigRootDir: import.meta.dirname
      }
    }
  }
);
```

```js
// prettier.config.mjs
export default {
  semi: true,
  singleQuote: false,
  trailingComma: "all"
};
```

```gitignore
# .gitignore
node_modules
dist
coverage
.DS_Store
*.tsbuildinfo
```

```ini
# .editorconfig
root = true

[*]
charset = utf-8
end_of_line = lf
insert_final_newline = true
indent_style = space
indent_size = 2
trim_trailing_whitespace = true
```

- [ ] **Step 4: Install the workspace toolchain**

Run: `pnpm install`
Expected: SUCCESS and a `pnpm-lock.yaml` file is created

- [ ] **Step 5: Run the workspace foundation test to verify it passes**

Run: `pnpm exec vitest run test/workspace-foundation.test.ts`
Expected: PASS

- [ ] **Step 6: Commit the root scaffold**

```bash
git add .editorconfig .gitignore eslint.config.mjs package.json pnpm-lock.yaml pnpm-workspace.yaml prettier.config.mjs test/workspace-foundation.test.ts tsconfig.base.json tsconfig.json vitest.config.ts
git commit -m "chore: scaffold root workspace tooling"
```

### Task 2: Shared Package Skeleton

**Files:**
- Create: `test/shared-package.test.ts`
- Create: `packages/shared/package.json`
- Create: `packages/shared/tsconfig.json`
- Create: `packages/shared/src/index.ts`
- Create: `packages/shared/src/provider-identity.ts`
- Create: `packages/shared/src/endpoint-health.ts`

- [ ] **Step 1: Write the failing shared package test**

```ts
// test/shared-package.test.ts
import { describe, expect, it } from "vitest";
import {
  createProviderIdentity,
  endpointHealthStates,
  sharedPackageName
} from "../packages/shared/src/index.ts";

describe("@ai-whisper/shared", () => {
  it("exports provider identity helpers and endpoint health literals", () => {
    expect(sharedPackageName).toBe("@ai-whisper/shared");

    expect(
      createProviderIdentity({
        providerId: "openai-codex",
        toolFamily: "codex",
        providerVersion: "1.0.0"
      }),
    ).toEqual({
      providerId: "openai-codex",
      toolFamily: "codex",
      providerVersion: "1.0.0"
    });

    expect(endpointHealthStates).toContain("healthy");
    expect(endpointHealthStates).toContain("degraded");
    expect(endpointHealthStates).toContain("offline");
  });
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `pnpm exec vitest run test/shared-package.test.ts`
Expected: FAIL because the shared package files do not exist yet

- [ ] **Step 3: Create the shared package**

```json
// packages/shared/package.json
{
  "name": "@ai-whisper/shared",
  "private": true,
  "type": "module",
  "main": "dist/index.js",
  "types": "dist/index.d.ts",
  "exports": {
    ".": {
      "types": "./dist/index.d.ts",
      "default": "./dist/index.js"
    }
  },
  "scripts": {
    "build": "tsc -p tsconfig.json",
    "typecheck": "tsc --noEmit -p tsconfig.json"
  }
}
```

```json
// packages/shared/tsconfig.json
{
  "extends": "../../tsconfig.base.json",
  "compilerOptions": {
    "composite": true,
    "rootDir": "src",
    "outDir": "dist",
    "tsBuildInfoFile": "dist/.tsbuildinfo"
  },
  "include": ["src/**/*.ts"]
}
```

```ts
// packages/shared/src/provider-identity.ts
export type ProviderIdentity = {
  providerId: string;
  toolFamily: string;
  providerVersion: string;
};

export function createProviderIdentity(
  input: ProviderIdentity,
): ProviderIdentity {
  return input;
}
```

```ts
// packages/shared/src/endpoint-health.ts
export const endpointHealthStates = ["healthy", "degraded", "offline"] as const;

export type EndpointHealthState = (typeof endpointHealthStates)[number];
```

```ts
// packages/shared/src/index.ts
export const sharedPackageName = "@ai-whisper/shared";

export {
  endpointHealthStates,
  type EndpointHealthState
} from "./endpoint-health.js";
export {
  createProviderIdentity,
  type ProviderIdentity
} from "./provider-identity.js";
```

- [ ] **Step 4: Run the shared package test to verify it passes**

Run: `pnpm exec vitest run test/shared-package.test.ts`
Expected: PASS

- [ ] **Step 5: Build and typecheck the shared package**

Run: `pnpm --filter @ai-whisper/shared build && pnpm --filter @ai-whisper/shared typecheck`
Expected: SUCCESS and `packages/shared/dist` is created

- [ ] **Step 6: Commit the shared package scaffold**

```bash
git add packages/shared/package.json packages/shared/src/index.ts packages/shared/src/provider-identity.ts packages/shared/src/endpoint-health.ts packages/shared/tsconfig.json test/shared-package.test.ts
git commit -m "feat: add shared package foundation"
```

### Task 3: Runtime Package Boundaries

**Files:**
- Create: `test/runtime-packages.test.ts`
- Create: `packages/cli/package.json`
- Create: `packages/cli/tsconfig.json`
- Create: `packages/cli/src/index.ts`
- Create: `packages/broker/package.json`
- Create: `packages/broker/tsconfig.json`
- Create: `packages/broker/src/index.ts`
- Create: `packages/companion-core/package.json`
- Create: `packages/companion-core/tsconfig.json`
- Create: `packages/companion-core/src/index.ts`
- Create: `packages/adapter-codex/package.json`
- Create: `packages/adapter-codex/tsconfig.json`
- Create: `packages/adapter-codex/src/index.ts`
- Create: `packages/adapter-claude/package.json`
- Create: `packages/adapter-claude/tsconfig.json`
- Create: `packages/adapter-claude/src/index.ts`

- [ ] **Step 1: Write the failing runtime package boundary test**

```ts
// test/runtime-packages.test.ts
import { describe, expect, it } from "vitest";
import { brokerPackage } from "../packages/broker/src/index.ts";
import { cliPackage } from "../packages/cli/src/index.ts";
import { companionCorePackage } from "../packages/companion-core/src/index.ts";
import { adapterClaudePackage } from "../packages/adapter-claude/src/index.ts";
import { adapterCodexPackage } from "../packages/adapter-codex/src/index.ts";

describe("runtime package boundaries", () => {
  it("exposes minimal package entry points for every runtime package", () => {
    expect(cliPackage.name).toBe("@ai-whisper/cli");
    expect(brokerPackage.name).toBe("@ai-whisper/broker");
    expect(companionCorePackage.name).toBe("@ai-whisper/companion-core");
    expect(adapterCodexPackage.name).toBe("@ai-whisper/adapter-codex");
    expect(adapterClaudePackage.name).toBe("@ai-whisper/adapter-claude");
  });
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `pnpm exec vitest run test/runtime-packages.test.ts`
Expected: FAIL because the runtime package files do not exist yet

- [ ] **Step 3: Create the runtime package skeletons**

```json
// packages/cli/package.json
{
  "name": "@ai-whisper/cli",
  "private": true,
  "type": "module",
  "main": "dist/index.js",
  "types": "dist/index.d.ts",
  "exports": {
    ".": {
      "types": "./dist/index.d.ts",
      "default": "./dist/index.js"
    }
  },
  "scripts": {
    "build": "tsc -p tsconfig.json",
    "typecheck": "tsc --noEmit -p tsconfig.json"
  }
}
```

```json
// packages/cli/tsconfig.json
{
  "extends": "../../tsconfig.base.json",
  "compilerOptions": {
    "composite": true,
    "rootDir": "src",
    "outDir": "dist",
    "tsBuildInfoFile": "dist/.tsbuildinfo"
  },
  "include": ["src/**/*.ts"]
}
```

```ts
// packages/cli/src/index.ts
export const cliPackage = {
  name: "@ai-whisper/cli"
} as const;
```

```json
// packages/broker/package.json
{
  "name": "@ai-whisper/broker",
  "private": true,
  "type": "module",
  "main": "dist/index.js",
  "types": "dist/index.d.ts",
  "exports": {
    ".": {
      "types": "./dist/index.d.ts",
      "default": "./dist/index.js"
    }
  },
  "scripts": {
    "build": "tsc -p tsconfig.json",
    "typecheck": "tsc --noEmit -p tsconfig.json"
  }
}
```

```json
// packages/broker/tsconfig.json
{
  "extends": "../../tsconfig.base.json",
  "compilerOptions": {
    "composite": true,
    "rootDir": "src",
    "outDir": "dist",
    "tsBuildInfoFile": "dist/.tsbuildinfo"
  },
  "include": ["src/**/*.ts"]
}
```

```ts
// packages/broker/src/index.ts
export const brokerPackage = {
  name: "@ai-whisper/broker"
} as const;
```

```json
// packages/companion-core/package.json
{
  "name": "@ai-whisper/companion-core",
  "private": true,
  "type": "module",
  "main": "dist/index.js",
  "types": "dist/index.d.ts",
  "exports": {
    ".": {
      "types": "./dist/index.d.ts",
      "default": "./dist/index.js"
    }
  },
  "scripts": {
    "build": "tsc -p tsconfig.json",
    "typecheck": "tsc --noEmit -p tsconfig.json"
  }
}
```

```json
// packages/companion-core/tsconfig.json
{
  "extends": "../../tsconfig.base.json",
  "compilerOptions": {
    "composite": true,
    "rootDir": "src",
    "outDir": "dist",
    "tsBuildInfoFile": "dist/.tsbuildinfo"
  },
  "include": ["src/**/*.ts"]
}
```

```ts
// packages/companion-core/src/index.ts
export const companionCorePackage = {
  name: "@ai-whisper/companion-core"
} as const;
```

```json
// packages/adapter-codex/package.json
{
  "name": "@ai-whisper/adapter-codex",
  "private": true,
  "type": "module",
  "main": "dist/index.js",
  "types": "dist/index.d.ts",
  "exports": {
    ".": {
      "types": "./dist/index.d.ts",
      "default": "./dist/index.js"
    }
  },
  "scripts": {
    "build": "tsc -p tsconfig.json",
    "typecheck": "tsc --noEmit -p tsconfig.json"
  }
}
```

```json
// packages/adapter-codex/tsconfig.json
{
  "extends": "../../tsconfig.base.json",
  "compilerOptions": {
    "composite": true,
    "rootDir": "src",
    "outDir": "dist",
    "tsBuildInfoFile": "dist/.tsbuildinfo"
  },
  "include": ["src/**/*.ts"]
}
```

```ts
// packages/adapter-codex/src/index.ts
export const adapterCodexPackage = {
  name: "@ai-whisper/adapter-codex"
} as const;
```

```json
// packages/adapter-claude/package.json
{
  "name": "@ai-whisper/adapter-claude",
  "private": true,
  "type": "module",
  "main": "dist/index.js",
  "types": "dist/index.d.ts",
  "exports": {
    ".": {
      "types": "./dist/index.d.ts",
      "default": "./dist/index.js"
    }
  },
  "scripts": {
    "build": "tsc -p tsconfig.json",
    "typecheck": "tsc --noEmit -p tsconfig.json"
  }
}
```

```json
// packages/adapter-claude/tsconfig.json
{
  "extends": "../../tsconfig.base.json",
  "compilerOptions": {
    "composite": true,
    "rootDir": "src",
    "outDir": "dist",
    "tsBuildInfoFile": "dist/.tsbuildinfo"
  },
  "include": ["src/**/*.ts"]
}
```

```ts
// packages/adapter-claude/src/index.ts
export const adapterClaudePackage = {
  name: "@ai-whisper/adapter-claude"
} as const;
```

- [ ] **Step 4: Run the runtime package boundary test to verify it passes**

Run: `pnpm exec vitest run test/runtime-packages.test.ts`
Expected: PASS

- [ ] **Step 5: Build and typecheck all runtime packages**

Run: `pnpm -r --if-present build && pnpm -r --if-present typecheck`
Expected: SUCCESS and each package emits a `dist` directory

- [ ] **Step 6: Commit the runtime package skeletons**

```bash
git add packages/adapter-claude packages/adapter-codex packages/broker packages/cli packages/companion-core test/runtime-packages.test.ts
git commit -m "feat: add runtime package boundaries"
```

### Task 4: Developer Guide and Full Workspace Verification

**Files:**
- Create: `test/readme-smoke.test.ts`
- Create: `README.md`

- [ ] **Step 1: Write the failing README smoke test**

```ts
// test/readme-smoke.test.ts
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";

const root = fileURLToPath(new URL("..", import.meta.url));

describe("README", () => {
  it("documents the phase-1 developer workflow", () => {
    const readme = readFileSync(resolve(root, "README.md"), "utf8");

    expect(readme).toContain("pnpm install");
    expect(readme).toContain("pnpm test");
    expect(readme).toContain("pnpm typecheck");
    expect(readme).toContain("pnpm lint");
    expect(readme).toContain("packages/shared");
    expect(readme).toContain("packages/broker");
  });
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `pnpm exec vitest run test/readme-smoke.test.ts`
Expected: FAIL because `README.md` does not exist yet

- [ ] **Step 3: Write the root README**

```md
# ai-whisper

Local collaboration bridge for paired AI agent sessions.

## Current Scope

This repository is being built in incremental phases. Phase 1 establishes the workspace, tooling, and package boundaries only.

## Workspace Commands

```bash
pnpm install
pnpm test
pnpm typecheck
pnpm lint
pnpm format
```

## Package Layout

- `packages/shared` - shared types and contract helpers
- `packages/cli` - future `whisper` command surface
- `packages/broker` - future local collaboration broker
- `packages/companion-core` - future companion runtime
- `packages/adapter-codex` - future Codex provider
- `packages/adapter-claude` - future Claude provider

## Phase Roadmap

- Phase 1: foundation
- Phase 2: shared contracts and broker skeleton
- Phase 3: collaboration and thread engine
- Phase 4: companion runtime and generic provider layer
- Phase 5: real user workflow
```

- [ ] **Step 4: Run full workspace verification**

Run: `pnpm test && pnpm typecheck && pnpm lint`
Expected: SUCCESS for the full Phase 1 workspace

- [ ] **Step 5: Commit the Phase 1 finishing pass**

```bash
git add README.md test/readme-smoke.test.ts
git commit -m "docs: add phase 1 workspace guide"
```
