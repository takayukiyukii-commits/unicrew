import nextVitals from "eslint-config-next/core-web-vitals";

const config = [
  ...nextVitals,
  {
    rules: {
      "react-hooks/immutability": "off",
      "react-hooks/purity": "off",
      "react-hooks/refs": "off",
      "react-hooks/set-state-in-effect": "off",
      "react-hooks/static-components": "off",
    },
  },
  {
    ignores: [
      ".next/**",
      ".next-tauri/**",
      "out/**",
      "node_modules/**",
      "src-tauri/**",
      "THIRD_PARTY_LICENSES/**",
    ],
  },
];

export default config;
