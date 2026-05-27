const { build } = require("esbuild");
const { cpSync, existsSync, mkdirSync } = require("fs");
const path = require("path");

const DIST = path.join(__dirname, "dist");

mkdirSync(DIST, { recursive: true });

build({
  entryPoints: [path.join(__dirname, "src", "app.js")],
  bundle: true,
  platform: "node",
  target: "node22",
  outfile: path.join(DIST, "app.js"),
  format: "cjs",
  external: ["pg-native"],
  minify: false,
  sourcemap: false,
}).then(() => {
  for (const fileName of ["accounts.csv", "accounts.example.csv"]) {
    const source = path.join(__dirname, "src", fileName);
    if (existsSync(source)) cpSync(source, path.join(DIST, fileName));
  }
  cpSync(
    path.join(__dirname, "src", "rds-global-bundle.pem"),
    path.join(DIST, "rds-global-bundle.pem")
  );
  console.log("Build complete: app/dist/app.js + runtime assets");
});
