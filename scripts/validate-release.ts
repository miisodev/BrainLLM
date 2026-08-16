// Release-metadata gate: everything the MCP Registry and npm check, checked
// here first — on every push, not only at tag time.
//
// Each rule below is one that actually bit. server.json sat INVALID against its
// own declared schema for four releases (a 259-character description against a
// 100-character limit) and nobody knew, because nothing validated it: the file
// was maintained, version-bumped and never once checked. The registry would have
// rejected it at publish, which is the most expensive moment to find out, since
// the npm half of the release is immutable by then.
//
// Run by CI on every push and by the publish workflow before it ships anything.

import Ajv2020 from "ajv/dist/2020.js";
import addFormats from "ajv-formats";
import server from "../server.json" with { type: "json" };
import pkg from "../package.json" with { type: "json" };
import manifest from "../manifest.json" with { type: "json" };

const problems: string[] = [];
const passed: string[] = [];

// 1 ── server.json against the schema it declares.
//
// Against the DECLARED schema, deliberately, rather than a pinned one: the file
// names its own contract, and checking it against anything else would let the
// two drift apart while still reporting green.
const schemaUrl = (server as { $schema?: string }).$schema;
if (!schemaUrl) {
  problems.push("server.json declares no $schema, so nothing can validate it");
} else {
  const res = await fetch(schemaUrl);
  if (!res.ok) {
    problems.push(`declared $schema is not fetchable (${res.status}): ${schemaUrl}`);
  } else {
    const ajv = new Ajv2020({ strict: false, allErrors: true });
    addFormats(ajv);
    const schema = { ...(await res.json()) } as Record<string, unknown>;
    delete schema.$schema;
    const body = { ...(server as Record<string, unknown>) };
    delete body.$schema;
    const validate = ajv.compile(schema);
    if (validate(body)) {
      passed.push(`server.json valid against ${schemaUrl.split("/").at(-2)}`);
    } else {
      for (const e of validate.errors ?? []) {
        problems.push(`server.json${e.instancePath} ${e.message}`);
      }
    }
  }
}

// 2 ── npm ownership proof. The registry fetches the published package and
//      reads mcpName off it; a mismatch is only discovered at registry-publish
//      time, one immutable npm version too late to correct in place.
const mcpName = (pkg as { mcpName?: string }).mcpName;
if (!mcpName) problems.push(`package.json has no "mcpName" — the MCP Registry requires "${server.name}"`);
else if (mcpName !== server.name) problems.push(`package.json mcpName "${mcpName}" != server.json name "${server.name}"`);
else passed.push(`mcpName matches server name (${mcpName})`);

// 3 ── The version sites agree. Six across five files, and they have drifted
//      independently more than once — server.json's nested package version is
//      the one the registry actually reads.
const versions: Array<[string, string]> = [
  ["package.json", pkg.version],
  ["manifest.json", manifest.version],
  ["server.json", server.version],
  ["server.json packages[0]", server.packages?.[0]?.version ?? "(absent)"],
];
const distinct = [...new Set(versions.map(([, v]) => v))];
if (distinct.length > 1) {
  problems.push(`version drift: ${versions.map(([k, v]) => `${k}=${v}`).join(", ")}`);
} else {
  passed.push(`all version sites agree (${distinct[0]})`);
}

// 4 ── Namespace must match the identity the publish will authenticate as.
const ns = /^io\.github\.([^/]+)\//.exec(server.name ?? "");
if (!ns) problems.push(`server.json name "${server.name}" is not io.github.<owner>/<name>; GitHub auth cannot claim it`);
else passed.push(`namespace io.github.${ns[1]} — publish must authenticate as that GitHub owner`);

for (const p of passed) console.log(`  + ${p}`);
if (problems.length) {
  console.error("\nRelease metadata is not publishable:");
  for (const p of problems) console.error(`  ! ${p}`);
  process.exit(1);
}
console.log("\nRelease metadata OK.");
