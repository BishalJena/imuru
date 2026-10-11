import type { McpServer } from "@modelcontextprotocol/server";
import * as z from "zod/v4";
import { dayRange, isCalendarDate, localDate, localIso } from "./dates.js";
import { WooError, type WooClient } from "./woo.js";

const ORDER_STATUSES = [
  "pending",
  "processing",
  "on-hold",
  "completed",
  "cancelled",
  "refunded",
  "failed",
] as const;

const price = z.string().regex(/^\d+(\.\d{1,2})?$/, "decimal string, e.g. 499 or 499.00");
const page = z.number().int().min(1).default(1);
const perPage = z.number().int().min(1).max(50).default(20);
const isoDateTime = z
  .string()
  .regex(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}$/, "store-local datetime, YYYY-MM-DDTHH:MM:SS");

const product = z.object({
  id: z.number(),
  name: z.string(),
  sku: z.string(),
  price: z.string(),
  regular_price: z.string(),
  status: z.string(),
  permalink: z.string(),
});

const orderSummary = z.object({
  id: z.number(),
  number: z.string(),
  status: z.string(),
  total: z.string(),
  currency: z.string(),
  date_created: z.string(),
  customer: z.string(),
  item_count: z.number(),
  payment_method: z.string(),
});

const order = orderSummary.extend({
  email: z.string(),
  line_items: z.array(
    z.object({ product_id: z.number(), name: z.string(), quantity: z.number(), total: z.string() }),
  ),
});

interface WooProduct {
  id: number;
  name: string;
  sku: string;
  price: string;
  regular_price: string;
  status: string;
  permalink: string;
}

interface WooOrder {
  id: number;
  number: string;
  status: string;
  total: string;
  currency: string;
  date_created: string;
  payment_method_title: string;
  billing: { first_name: string; last_name: string; email: string };
  line_items: { product_id: number; name: string; quantity: number; total: string }[];
}

const toProduct = (p: WooProduct): z.infer<typeof product> => ({
  id: p.id,
  name: p.name,
  sku: p.sku,
  price: p.price,
  regular_price: p.regular_price,
  status: p.status,
  permalink: p.permalink,
});

const toSummary = (o: WooOrder): z.infer<typeof orderSummary> => ({
  id: o.id,
  number: o.number,
  status: o.status,
  total: o.total,
  currency: o.currency,
  date_created: o.date_created,
  customer: `${o.billing.first_name} ${o.billing.last_name}`.trim(),
  item_count: o.line_items.reduce((n, li) => n + li.quantity, 0),
  payment_method: o.payment_method_title,
});

const toOrder = (o: WooOrder): z.infer<typeof order> => ({
  ...toSummary(o),
  email: o.billing.email,
  line_items: o.line_items.map((li) => ({
    product_id: li.product_id,
    name: li.name,
    quantity: li.quantity,
    total: li.total,
  })),
});

function ok<T extends object>(output: T) {
  return {
    content: [{ type: "text" as const, text: JSON.stringify(output) }],
    structuredContent: output,
  };
}

function inputError(message: string) {
  return { content: [{ type: "text" as const, text: message }], isError: true };
}

function fail(err: unknown, notFound?: string) {
  const message =
    err instanceof WooError
      ? err.status === 404 && notFound
        ? notFound
        : err.message
      : "Unexpected error in the WooCommerce MCP server";
  return { content: [{ type: "text" as const, text: message }], isError: true };
}

export interface StoreInfo {
  name: string;
  url: string;
  timezone: string;
  currency: string;
}

export function registerTools(
  server: McpServer,
  woo: WooClient,
  store: () => Promise<StoreInfo>,
  now: () => Date = () => new Date(),
): void {
  server.registerTool(
    "get_store_info",
    {
      title: "Store info",
      description:
        "Store name, URL, currency, timezone, and the current date and time in the store's timezone. Call this to find out what 'today' is before asking for today's orders.",
      inputSchema: z.object({}),
      outputSchema: z.object({
        name: z.string(),
        url: z.string(),
        currency: z.string(),
        timezone: z.string(),
        now: z.string(),
        today: z.string(),
      }),
      annotations: { readOnlyHint: true },
    },
    async () => {
      try {
        const s = await store();
        const t = now();
        return ok({ ...s, now: localIso(t, s.timezone), today: localDate(t, s.timezone) });
      } catch (err) {
        return fail(err);
      }
    },
  );

  server.registerTool(
    "list_products",
    {
      title: "List products",
      description: "List products in the store, newest first. Optionally filter by a search term.",
      inputSchema: z.object({
        search: z.string().max(100).optional().describe("Matches product name or description"),
        page,
        per_page: perPage,
      }),
      outputSchema: z.object({
        items: z.array(product),
        page: z.number(),
        per_page: z.number(),
        total: z.number(),
      }),
      annotations: { readOnlyHint: true },
    },
    async ({ search, page, per_page }) => {
      try {
        const { data, total } = await woo.get<WooProduct[]>("/products", {
          search,
          page,
          per_page,
        });
        return ok({ items: data.map(toProduct), page, per_page, total: total ?? data.length });
      } catch (err) {
        return fail(err);
      }
    },
  );

  server.registerTool(
    "create_product",
    {
      title: "Create product",
      description:
        "Create a simple product. It is published to the storefront immediately unless status is 'draft'.",
      inputSchema: z.object({
        name: z.string().min(1).max(200),
        regular_price: price.describe("Price in the store currency as a decimal string"),
        description: z.string().max(5000).optional(),
        status: z.enum(["publish", "draft"]).default("publish"),
      }),
      outputSchema: product,
    },
    async ({ name, regular_price, description, status }) => {
      try {
        const { data } = await woo.post<WooProduct>("/products", {
          type: "simple",
          name,
          regular_price,
          status,
          ...(description === undefined ? {} : { description }),
        });
        return ok(toProduct(data));
      } catch (err) {
        return fail(err);
      }
    },
  );

  server.registerTool(
    "list_orders",
    {
      title: "List orders",
      description:
        "List orders, newest first. Use `date` (YYYY-MM-DD, store-local) for all orders placed on one day, e.g. today from get_store_info. Or use `after`/`before` (store-local datetimes) for a custom range.",
      inputSchema: z.object({
        date: z
          .string()
          .regex(/^\d{4}-\d{2}-\d{2}$/)
          .optional()
          .describe("One store-local calendar day"),
        after: isoDateTime.optional(),
        before: isoDateTime.optional(),
        status: z.enum(ORDER_STATUSES).optional(),
        page,
        per_page: perPage,
      }),
      outputSchema: z.object({
        items: z.array(orderSummary),
        page: z.number(),
        per_page: z.number(),
        total: z.number(),
        range: z.object({
          after: z.string().nullable(),
          before: z.string().nullable(),
          timezone: z.string(),
        }),
      }),
      annotations: { readOnlyHint: true },
    },
    async ({ date, after, before, status, page, per_page }) => {
      // Input errors are reported as such; the generic "unexpected error" text is
      // for failures we did not anticipate.
      if (date && (after || before)) {
        return inputError("Use either date or after/before, not both");
      }
      if (date && !isCalendarDate(date)) return inputError(`not a calendar date: ${date}`);
      try {
        const range = date ? dayRange(date) : { after, before };
        // Store info only labels the range: fetched in parallel, and its
        // failure must not fail an order listing that succeeded.
        const [{ data, total }, timezone] = await Promise.all([
          woo.get<WooOrder[]>("/orders", {
            after: range.after,
            before: range.before,
            status,
            page,
            per_page,
          }),
          store().then(
            (s) => s.timezone,
            () => "unknown",
          ),
        ]);
        return ok({
          items: data.map(toSummary),
          page,
          per_page,
          total: total ?? data.length,
          range: { after: range.after ?? null, before: range.before ?? null, timezone },
        });
      } catch (err) {
        return fail(err);
      }
    },
  );

  server.registerTool(
    "get_order",
    {
      title: "Get order",
      description: "Get one order with its line items and customer details.",
      inputSchema: z.object({ id: z.number().int().positive() }),
      outputSchema: order,
      annotations: { readOnlyHint: true },
    },
    async ({ id }) => {
      try {
        const { data } = await woo.get<WooOrder>(`/orders/${id}`);
        return ok(toOrder(data));
      } catch (err) {
        return fail(err, `Order ${id} not found`);
      }
    },
  );

  server.registerTool(
    "update_order_status",
    {
      title: "Update order status",
      description: "Change an order's status, e.g. from 'processing' to 'completed'.",
      inputSchema: z.object({
        id: z.number().int().positive(),
        status: z.enum(ORDER_STATUSES),
      }),
      outputSchema: order,
      annotations: { idempotentHint: true },
    },
    async ({ id, status }) => {
      try {
        const { data } = await woo.put<WooOrder>(`/orders/${id}`, { status });
        return ok(toOrder(data));
      } catch (err) {
        return fail(err, `Order ${id} not found`);
      }
    },
  );
}
