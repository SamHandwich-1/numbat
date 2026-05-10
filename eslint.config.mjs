import { dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { FlatCompat } from "@eslint/eslintrc";

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

const compat = new FlatCompat({
  baseDirectory: __dirname,
});

const eslintConfig = [
  ...compat.extends("next/core-web-vitals", "next/typescript"),
  {
    files: ["components/**/*.tsx", "components/**/*.ts"],
    rules: {
      "no-restricted-imports": [
        "error",
        {
          patterns: [
            {
              group: ["@/lib/supabase/server"],
              message:
                "lib/supabase/server.ts is server-only. Components must use lib/supabase/client.ts (anon) for realtime; mutations go through Server Actions.",
            },
          ],
        },
      ],
    },
  },
];

export default eslintConfig;
