#!/usr/bin/env node
// Creates the NEAR hackathon issues and a Projects table from near-board.html.
//
//   GAURAV=gks2022004 ADITYA=<aditya-github-username> node scripts/create_github_board.mjs
//   DRY_RUN=1 GAURAV=... ADITYA=... node scripts/create_github_board.mjs   (prints, creates nothing)
//
// Needs the GitHub CLI logged in with the project scope: gh auth login && gh auth refresh -s project
// Aditya must be a collaborator on the repo, or GitHub rejects the assignment.

import { readFileSync } from "node:fs";
import { execFileSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const REPO = process.env.REPO || "gks2022004/nerf";
const OWNER = REPO.split("/")[0];
const GAURAV = process.env.GAURAV || OWNER;
const ADITYA = process.env.ADITYA;
const DRY = !!process.env.DRY_RUN;
const PROJECT_TITLE = process.env.PROJECT_TITLE || "2Options on NEAR";

if (!ADITYA) {
  console.error("Set ADITYA to Aditya's GitHub username.");
  process.exit(1);
}

const html = readFileSync(join(dirname(fileURLToPath(import.meta.url)), "..", "near-board.html"), "utf8");
const m = html.match(/var EPICS = (\[[\s\S]*?\n\]);\n/);
if (!m) throw new Error("Could not find the EPICS data in near-board.html");
const EPICS = new Function(`return ${m[1]}`)();

const assignees = (who) => (who === "gaurav" ? [GAURAV] : who === "aditya" ? [ADITYA] : [GAURAV, ADITYA]);

function gh(args, input) {
  if (DRY) {
    console.log("gh " + args.join(" ") + (input ? `   <body: ${input.length} chars>` : ""));
    return "";
  }
  return execFileSync("gh", args, { encoding: "utf8", input }).trim();
}

function ensureLabel(name, color, description) {
  try {
    gh(["label", "create", name, "--repo", REPO, "--color", color, "--description", description, "--force"]);
  } catch (e) {
    console.warn(`label ${name}: ${e.message.split("\n")[0]}`);
  }
}

function createIssue({ title, body, who, labels }) {
  const args = ["issue", "create", "--repo", REPO, "--title", title, "--body-file", "-"];
  for (const a of assignees(who)) args.push("--assignee", a);
  for (const l of labels) args.push("--label", l);
  const url = gh(args, body);
  return DRY ? { url: "(dry-run)", number: 0 } : { url, number: Number(url.split("/").pop()) };
}

ensureLabel("epic", "6f42c1", "Parent issue that groups sub-issues");
ensureLabel("stretch", "fbca04", "Only if time allows; pick one");
ensureLabel("should-ship", "0e8a16", "Differentiator, after the must-haves");

let project = null;
if (!DRY) {
  const out = gh(["project", "create", "--owner", OWNER, "--title", PROJECT_TITLE, "--format", "json"]);
  project = JSON.parse(out);
  console.log(`Project: ${project.url}`);
} else {
  gh(["project", "create", "--owner", OWNER, "--title", PROJECT_TITLE, "--format", "json"]);
}

function addToProject(url) {
  if (DRY) return gh(["project", "item-add", "<n>", "--owner", OWNER, "--url", url]);
  gh(["project", "item-add", String(project.number), "--owner", OWNER, "--url", url]);
}

for (const epic of EPICS) {
  // Sub-issues first so the epic can list real issue numbers.
  const kids = epic.kids.map((k) => {
    const labels = [];
    if (k.tag) labels.push(k.tag);
    const issue = createIssue({
      title: k.t,
      who: k.who,
      labels,
      body: `Part of **${epic.title}** (target ${k.d}).\n\nOwner: ${k.who === "both" ? "both" : k.who === "gaurav" ? "Gaurav" : "Aditya"}.`,
    });
    addToProject(issue.url);
    return { ...k, ...issue };
  });

  const tasks = kids.map((k) => `- [${k.s === "done" ? "x" : " "}] #${k.number} ${k.t}`).join("\n");
  const parent = createIssue({
    title: `${epic.title}`,
    who: epic.who,
    labels: ["epic"],
    body: `${epic.date}\n\n${tasks}\n`,
  });
  addToProject(parent.url);

  // Link as real sub-issues (GitHub sub-issues API). Falls back silently to the task list above.
  if (!DRY) {
    try {
      const parentId = gh(["api", `repos/${REPO}/issues/${parent.number}`, "--jq", ".id"]);
      for (const k of kids) {
        const childId = gh(["api", `repos/${REPO}/issues/${k.number}`, "--jq", ".id"]);
        gh(["api", "-X", "POST", `repos/${REPO}/issues/${parent.number}/sub_issues`, "-F", `sub_issue_id=${childId}`]);
      }
    } catch (e) {
      console.warn(`sub-issue linking skipped for "${epic.title}": ${e.message.split("\n")[0]}`);
    }
    // Issues already done go straight to Done.
    for (const k of kids) if (k.s === "done") gh(["issue", "close", String(k.number), "--repo", REPO]);
  }
  console.log(`${epic.title}: ${parent.url} (${kids.length} sub-issues)`);
}
console.log(DRY ? "Dry run finished." : "Done.");
