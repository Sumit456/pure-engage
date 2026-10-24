// Look up a PureNet member by identifier and print the platform /track payload it maps to.
// Usage: node scripts/sync-member.mjs [value] [system]   (defaults to the mock's MBR-TEST-0001)
import { createPureNetFromEnv, memberToAttributes, MEMBER_ID_SYSTEM } from '../src/index.js';

const [value = 'MBR-TEST-0001', system = MEMBER_ID_SYSTEM] = process.argv.slice(2);
const { client } = createPureNetFromEnv();

const attributes = [];
for await (const member of client.searchAllMembers(system, value)) {
  attributes.push(memberToAttributes(member, await client.listConsents(member.memberId)));
}
if (!attributes.length) {
  console.error(`No PureNet member for ${system}|${value}`);
  process.exit(1);
}
console.log(JSON.stringify({ attributes, events: [] }, null, 2));
