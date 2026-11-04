import { describe, expect, it } from "bun:test";
import type { FilterOperator, FilterValueInputProps } from "../../core";
import { carryOperand } from "./carry-operand";

const Single = (_: FilterValueInputProps) => null;
const Multi = (_: FilterValueInputProps) => null;
const Range = (_: FilterValueInputProps) => null;

function op(
  id: string,
  ValueInput?: FilterOperator["ValueInput"],
  arity?: FilterOperator["arity"],
): FilterOperator {
  return {
    id,
    label: id,
    hasValue: ValueInput !== undefined,
    ValueInput,
    arity,
    lower: () => undefined,
  };
}

const is = op("is", Single, "one");
const isNot = op("is-not", Single, "one");
const anyOf = op("is-any-of", Multi, "many");
const noneOf = op("is-none-of", Multi, "many");
const between = op("between", Range);
const isEmpty = op("is-empty");

describe("carryOperand", () => {
  it("keeps the operand between operators sharing an editor", () => {
    expect(carryOperand(is, isNot, "done")).toBe("done");
    expect(carryOperand(anyOf, noneOf, ["a", "b"])).toEqual(["a", "b"]);
  });

  it("converts one item ↔ a list across arities", () => {
    expect(carryOperand(is, anyOf, "done")).toEqual(["done"]);
    expect(carryOperand(noneOf, isNot, ["a", "b"])).toBe("a");
    expect(carryOperand(anyOf, is, [])).toBeUndefined();
  });

  it("drops the operand for unrelated shapes or a value-less target", () => {
    expect(carryOperand(is, between, "done")).toBeUndefined();
    expect(carryOperand(is, isEmpty, "done")).toBeUndefined();
    expect(carryOperand(isEmpty, is, undefined)).toBeUndefined();
  });
});
