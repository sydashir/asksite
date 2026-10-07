// `Missing` does not resolve, so `.canParse` below has no lib symbol to check.
declare const value: Missing;
export const hidden = value.canParse("x");
