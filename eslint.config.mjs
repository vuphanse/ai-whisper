import js from "@eslint/js";
import stylistic from "@stylistic/eslint-plugin";
import globals from "globals";
import tseslint from "typescript-eslint";

const typedConfigs = tseslint.configs.recommendedTypeChecked.map((config) => ({
	...config,
	files: ["**/*.ts"],
}));

export default tseslint.config(
	{
		ignores: [
			"**/dist/**",
			"**/coverage/**",
			"**/node_modules/**",
			"**/.worktrees/**",
			"**/deprecated/**",
			"docs/**",
		],
	},
	js.configs.recommended,
	{
		files: ["**/*.{ts,js,mjs,cjs}"],
		languageOptions: {
			globals: {
				...globals.node,
			},
		},
		plugins: {
			"@stylistic": stylistic,
		},
		rules: {
			"no-var": "error",
			"no-eval": "error",
			"no-trailing-spaces": "error",
			"no-multiple-empty-lines": ["error", { max: 1, maxEOF: 1 }],
			"@stylistic/quotes": ["error", "double", { avoidEscape: true }],
			"@stylistic/semi": ["error", "always"],
			"@stylistic/comma-dangle": ["error", "always-multiline"],
		},
	},
	...typedConfigs,
	{
		files: ["**/*.ts"],
		languageOptions: {
			globals: {
				...globals.node,
			},
			parserOptions: {
				projectService: true,
				tsconfigRootDir: import.meta.dirname,
			},
		},
	},
);
