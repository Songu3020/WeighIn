import { describe, it, expect } from "vitest";
import { toScVal } from "../src/measurement";
import { Keypair } from "@stellar/stellar-sdk";

describe("toScVal", () => {
  it("parses primitives", () => {
    expect(toScVal({ type: "u32", value: 123 }).switch().name).toBe("scvU32");
    expect(toScVal({ type: "i32", value: -123 }).switch().name).toBe("scvI32");
    expect(toScVal({ type: "symbol", value: "test" }).switch().name).toBe(
      "scvSymbol",
    );
    expect(toScVal({ type: "string", value: "hello" }).switch().name).toBe(
      "scvString",
    );
    expect(toScVal({ type: "bool", value: true }).switch().name).toBe(
      "scvBool",
    );
  });

  it("parses large integers safely from strings", () => {
    const u64 = toScVal({ type: "u64", value: "18446744073709551615" });
    expect(u64.switch().name).toBe("scvU64");

    const i128 = toScVal({
      type: "i128",
      value: "-170141183460469231731687303715884105728",
    });
    expect(i128.switch().name).toBe("scvI128");

    expect(() => toScVal({ type: "u64", value: "invalid" })).toThrow(
      /Invalid value for u64/,
    );
  });

  it("parses addresses", () => {
    const valid = Keypair.random().publicKey();
    const addr = toScVal({ type: "address", value: valid });
    expect(addr.switch().name).toBe("scvAddress");

    expect(() => toScVal({ type: "address", value: "invalid" })).toThrow(
      /Invalid value for address/,
    );
    expect(() => toScVal({ type: "address", value: 123 })).toThrow(
      /must be string/,
    );
  });

  it("parses bytes from hex", () => {
    const b = toScVal({ type: "bytes", value: "deadbeef" });
    expect(b.switch().name).toBe("scvBytes");
    expect(b.bytes().toString("hex")).toBe("deadbeef");

    expect(() => toScVal({ type: "bytes", value: "invalid" })).toThrow(
      /valid hex/,
    );
    expect(() => toScVal({ type: "bytes", value: "abc" })).toThrow(
      /even length/,
    );
  });

  it("parses recursive vectors and accepts bounded large payloads", () => {
    const largeValues = Array.from({ length: 256 }, (_, index) => ({
      type: "u32",
      value: index,
    }));
    const v = toScVal({
      type: "vec",
      value: [
        { type: "u32", value: 1 },
        { type: "vec", value: [{ type: "bool", value: true }] },
        ...largeValues,
      ],
    });
    expect(v.switch().name).toBe("scvVec");
    const arr = v.vec();
    expect(arr).toBeDefined();
    if (arr) {
      expect(arr[0].switch().name).toBe("scvU32");
      expect(arr[1].switch().name).toBe("scvVec");
      expect(arr[2].switch().name).toBe("scvU32");
      expect(arr[2].u32()).toBe(0);
      expect(arr[arr.length - 1].u32()).toBe(255);
    }

    expect(() => toScVal({ type: "vec", value: "not-array" })).toThrow(
      /must be array/,
    );
    expect(() => toScVal({ type: "vec", value: [{ type: "u32" }] })).toThrow(
      /Invalid vector element at index 0/,
    );
    expect(() =>
      toScVal({
        type: "vec",
        value: [{ type: "map", value: [{ key: { type: "u32", value: 1 } }] }],
      }),
    ).toThrow(/Invalid map entry at index 0/);
  });

  it("parses recursive maps", () => {
    const m = toScVal({
      type: "map",
      value: [
        {
          key: { type: "symbol", value: "foo" },
          value: { type: "u32", value: 42 },
        },
      ],
    });
    expect(m.switch().name).toBe("scvMap");
    const entries = m.map();
    expect(entries).toBeDefined();
    if (entries) {
      expect(entries[0].key().switch().name).toBe("scvSymbol");
      expect(entries[0].val().switch().name).toBe("scvU32");
    }

    expect(() => toScVal({ type: "map", value: "not-array" })).toThrow(
      /must be array/,
    );
    expect(() =>
      toScVal({ type: "map", value: [{ key: { type: "u32", value: 1 } }] }),
    ).toThrow(/Invalid map entry at index 0/);
  });

  it("sorts map entries canonically by key", () => {
    // Deliberately unsorted inputs: c, a, b
    const m = toScVal({
      type: "map",
      value: [
        {
          key: { type: "symbol", value: "c" },
          value: { type: "u32", value: 3 },
        },
        {
          key: { type: "symbol", value: "a" },
          value: { type: "u32", value: 1 },
        },
        {
          key: { type: "symbol", value: "b" },
          value: { type: "u32", value: 2 },
        },
      ],
    });

    expect(m.switch().name).toBe("scvMap");
    const entries = m.map();
    expect(entries).toBeDefined();
    if (entries) {
      // Should be ordered a, b, c
      expect(entries[0].key().sym().toString()).toBe("a");
      expect(entries[1].key().sym().toString()).toBe("b");
      expect(entries[2].key().sym().toString()).toBe("c");
    }
  });

  it("rejects map keys that encode identically", () => {
    // 1. Byte-identical keys
    expect(() =>
      toScVal({
        type: "map",
        value: [
          {
            key: { type: "symbol", value: "dup" },
            value: { type: "u32", value: 1 },
          },
          {
            key: { type: "symbol", value: "dup" },
            value: { type: "u32", value: 2 },
          },
        ],
      }),
    ).toThrow(/Duplicate map key detected at entry 1/);

    // 2. Differently formatted large integers that encode to identical ScVal
    expect(() =>
      toScVal({
        type: "map",
        value: [
          {
            key: { type: "u64", value: "100" },
            value: { type: "u32", value: 1 },
          },
          {
            key: { type: "u64", value: "0100" },
            value: { type: "u32", value: 2 },
          },
        ],
      }),
    ).toThrow(/Duplicate map key detected at entry 1/);

    // 3. Nested map with duplicate keys
    expect(() =>
      toScVal({
        type: "map",
        value: [
          {
            key: { type: "symbol", value: "nested" },
            value: {
              type: "map",
              value: [
                {
                  key: { type: "i32", value: 42 },
                  value: { type: "bool", value: true },
                },
                {
                  key: { type: "i32", value: 42 },
                  value: { type: "bool", value: false },
                },
              ],
            },
          },
        ],
      }),
    ).toThrow(/Duplicate map key detected at entry 1/);
  });

  it("permits keys with different ScVal types even if their string representations match", () => {
    // Symbol "test" vs String "test"
    const m = toScVal({
      type: "map",
      value: [
        {
          key: { type: "symbol", value: "test" },
          value: { type: "u32", value: 1 },
        },
        {
          key: { type: "string", value: "test" },
          value: { type: "u32", value: 2 },
        },
      ],
    });
    expect(m.switch().name).toBe("scvMap");
    expect(m.map()?.length).toBe(2);
  });

  it("does not mutate the input fixture when sorting map entries", () => {
    const original = [
      {
        key: { type: "symbol", value: "z" },
        value: { type: "u32", value: 26 },
      },
      { key: { type: "symbol", value: "a" }, value: { type: "u32", value: 1 } },
    ];
    toScVal({ type: "map", value: original });
    expect(original[0].key.value).toBe("z");
    expect(original[1].key.value).toBe("a");
  });
});
