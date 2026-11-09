import tseslint from "typescript-eslint";
export default [
  { ignores: ["dist/**", "src/generated/**", "node_modules/**"] },
  ...tseslint.configs.recommended,
  { rules: { "@typescript-eslint/no-explicit-any": "error" } },
];
