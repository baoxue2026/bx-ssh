import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const workspace = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "..",
);
const DEFAULT_REQUIRED_CHECK = "Release gate";

export function loadProtection(pathname, root = workspace) {
  return JSON.parse(readFileSync(path.resolve(root, pathname), "utf8"));
}

export function validateMainBranchProtection(
  protection,
  { requiredCheck = DEFAULT_REQUIRED_CHECK } = {},
) {
  const violations = [];
  if (!isObject(protection)) {
    return ["main branch protection response must be a JSON object"];
  }
  if (!nonEmptyString(requiredCheck)) {
    violations.push("required branch check name must be a non-empty string");
  }

  const statusChecks = protection.required_status_checks;
  if (!isObject(statusChecks)) {
    violations.push(
      "main branch protection must require status checks before merging",
    );
  } else {
    if (statusChecks.strict !== true) {
      violations.push(
        "main branch protection required_status_checks.strict must be true",
      );
    }
    const checks = [
      ...(Array.isArray(statusChecks.checks)
        ? statusChecks.checks.map((check) =>
            typeof check === "string" ? check : check?.context,
          )
        : []),
      ...(Array.isArray(statusChecks.contexts) ? statusChecks.contexts : []),
    ].filter(nonEmptyString);
    if (checks.length === 0) {
      violations.push(
        "main branch protection must define at least one required status check",
      );
    }
    if (nonEmptyString(requiredCheck) && !checks.includes(requiredCheck)) {
      violations.push(
        `main branch protection must require the ${requiredCheck} status check`,
      );
    }
  }

  const reviews = protection.required_pull_request_reviews;
  if (!isObject(reviews)) {
    violations.push("main branch protection must require pull-request reviews");
  } else {
    if (!Number.isInteger(reviews.required_approving_review_count)) {
      violations.push(
        "main branch protection approval count must be an integer",
      );
    } else if (reviews.required_approving_review_count < 1) {
      violations.push(
        "main branch protection must require at least one approval",
      );
    }
    if (reviews.dismiss_stale_reviews !== true) {
      violations.push("main branch protection must dismiss stale approvals");
    }
  }

  for (const [field, expected, description] of [
    ["enforce_admins", true, "protect administrators"],
    ["required_linear_history", true, "require linear history"],
    [
      "required_conversation_resolution",
      true,
      "require conversation resolution",
    ],
    ["allow_force_pushes", false, "disable force pushes"],
    ["allow_deletions", false, "disable branch deletion"],
  ]) {
    const setting = protection[field];
    if (!isObject(setting) || setting.enabled !== expected) {
      violations.push(
        `main branch protection must ${description} (invalid ${field})`,
      );
    }
  }

  return violations;
}

function isObject(value) {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function nonEmptyString(value) {
  return typeof value === "string" && value.trim().length > 0;
}

function parseArguments(argv) {
  const values = {};
  for (let index = 0; index < argv.length; index += 2) {
    const argument = argv[index];
    const value = argv[index + 1];
    if (!argument?.startsWith("--") || !value) {
      throw new Error(`参数缺失或无效：${argument ?? "<missing>"}`);
    }
    values[argument.slice(2)] = value;
  }
  if (!values.input)
    throw new Error("必须提供 --input <branch-protection.json>");
  return values;
}

function main() {
  try {
    const options = parseArguments(process.argv.slice(2));
    const protection = loadProtection(options.input);
    const violations = validateMainBranchProtection(protection, {
      requiredCheck: options["required-check"] ?? DEFAULT_REQUIRED_CHECK,
    });
    if (violations.length > 0) {
      console.error("main 分支保护校验失败：");
      for (const violation of violations) console.error(`- ${violation}`);
      process.exitCode = 1;
      return;
    }
    console.log(
      "main 分支保护校验通过（状态检查、审批、历史和破坏性操作限制）。",
    );
  } catch (error) {
    console.error(`main 分支保护校验失败：${error.message}`);
    process.exitCode = 1;
  }
}

if (
  process.argv[1] &&
  import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href
) {
  main();
}
