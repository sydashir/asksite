// The Orders list's filters, remembered for this tab only, so "All orders" on an order goes back to the list as it was.
let lastSearch = "";

export function rememberOrdersSearch(search: string): void {
  lastSearch = search;
}

/** "/orders" plus the filters the list last showed in this tab. */
export const ordersBackHref = (): string => `/orders${lastSearch}`;
