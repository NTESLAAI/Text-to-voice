// Render-only mock: never uses DOM, network, storage or application env.
const { test } = require("node:test"),
  assert = require("node:assert/strict");
const { readFileSync } = require("node:fs"),
  { resolve } = require("node:path"),
  { runInNewContext } = require("node:vm");
const ts = require("typescript");
function load(file, mocks = {}) {
  const exports = {};
  const source = readFileSync(resolve(__dirname, "../src", file), "utf8");
  const code = ts.transpileModule(source, {
    compilerOptions: {
      module: ts.ModuleKind.CommonJS,
      jsx: ts.JsxEmit.ReactJSX,
      esModuleInterop: true,
    },
  }).outputText;
  runInNewContext(code, {
    exports,
    require(name) {
      if (!Object.hasOwn(mocks, name)) throw Error("UNMOCKED_IMPORT");
      return mocks[name];
    },
    Intl,
    Date,
  });
  return exports.default;
}
function render(extra = {}) {
  const payment = {
    id: "p",
    userName: "Synthetic",
    email: "synthetic@example.invalid",
    type: "NEW",
    plan: "BASIC",
    amount: "100",
    transferCode: "synthetic",
    status: "Pending",
    statusCode: "PENDING",
    provider: "BANK_TRANSFER",
    createdAt: "",
    paidAt: null,
    matchedAmount: 140,
    surplusAmount: 40,
    currency: "VND",
    transactions: [],
    ...extra,
  };
  let index = 0;
  const jsx = (type, props) => ({ type, props });
  const fail = () => {
    throw Error("API_FORBIDDEN");
  };
  const Component = load("components/admin/AdminPayments.tsx", {
    react: {
      useEffect() {},
      useState(initial) {
        const i = index++;
        return [i === 5 ? payment : i === 6 ? false : initial, () => {}];
      },
    },
    "react/jsx-runtime": { jsx, jsxs: jsx },
    "react-i18next": { useTranslation: () => ({ t: (key) => key }) },
    "../../services/api": {
      confirmAdminPayment: fail,
      getAdminPayments: fail,
      getUnmatchedTransactions: fail,
    },
  });
  return Component();
}
function nodes(value, result = []) {
  if (value && typeof value === "object") {
    if (value.type) result.push(value);
    for (const child of Object.values(value.props || {})) {
      if (Array.isArray(child)) child.forEach((c) => nodes(c, result));
      else if (child && typeof child === "object") nodes(child, result);
    }
  }
  return result;
}
test("legacy/UNKNOWN disables confirmation and explains review", () => {
  const n = nodes(
    render({ spendabilityStatus: "UNKNOWN", spendableAmount: null }),
  );
  assert.equal(
    n.find((x) => x.props.className === "admin-modal-confirm").props.disabled,
    true,
  );
  assert(
    n.some(
      (x) =>
        x.props.role === "status" &&
        x.props.children === "bankPolicy.reviewRequired",
    ),
  );
  assert(
    n.some(
      (x) =>
        x.type === "strong" && x.props.children === "bankPolicy.unverified",
    ),
  );
});
test("missing old-server metadata never defaults to VERIFIED or spendable zero", () => {
  const n = nodes(render());
  assert.equal(
    n.find((x) => x.props.className === "admin-modal-confirm").props.disabled,
    true,
  );
  assert(
    n.some(
      (x) =>
        x.type === "strong" && x.props.children === "bankPolicy.unverified",
    ),
  );
});
test("verified zero surplus remains distinguishable from UNKNOWN", () => {
  const n = nodes(
    render({ spendabilityStatus: "VERIFIED", spendableAmount: "0" }),
  );
  assert.equal(
    n.find((x) => x.props.className === "admin-modal-confirm").props.disabled,
    false,
  );
  assert(!n.some((x) => x.props.role === "status"));
});
test("account display contains only the masked view supplied by API", () => {
  const n = nodes(
    render({
      receivingBankAccount: {
        code: "synthetic",
        accountNumberMasked: "***0123",
        policy: "MANUAL_ALLOWED",
      },
    }),
  );
  assert(
    n.some(
      (x) =>
        x.type === "strong" &&
        typeof x.props.children === "string" &&
        x.props.children.includes("***0123"),
    ),
  );
});
test("new bank policy labels exist in Vietnamese and English", () => {
  for (const lang of ["vi", "en"]) {
    const locale = load("i18n/locales/" + lang + ".ts");
    for (const key of [
      "account",
      "unknown",
      "spendable",
      "unverified",
      "reviewRequired",
    ])
      assert.equal(typeof locale.translation.bankPolicy[key], "string");
  }
});
