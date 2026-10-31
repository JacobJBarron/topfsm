/**
 * The files for moving to Jobber (jobberExport.ts): Jobber's own column names, its statuses, dates
 * and limits, and what stays out. The header rows below are copied from Jobber's sample files
 * (help.getjobber.com, October 2026); the quote, job and invoice imports take no others.
 */
import { describe, expect, it } from "vitest";
import {
  countryName, fitLines, JOBBER_COLUMNS, jobberExport, jobberLeadSource, jobberName, jobberReadme, jobberRepeat,
  type JobberInput, type JobberJob, type JobberLine, type JobberQuote,
} from "../src/jobberExport";

const SAMPLE_HEADERS = {
  quotes:
    "Jobber Client ID,Client Title,Client First Name,Client Last Name,Client Full Name (Display Only),Client Company Name,Client Is a Company? (True/False),Client Email,Client Main Phone,Client Home Phone,Client Work Phone,Client Mobile Phone,Client Fax Phone,Client Other Phone,Client SMS Enabled Phone Number,Jobber Property ID,Property Street 1,Property Street 2,Property City,Property State/Province,Property Zip/Postal Code,Property Country,Billing Street 1,Billing Street 2,Billing City,Billing State/Province,Billing Zip/Postal Code,Billing Country,Client Receives Auto Visit Reminders? (True/False),Client Receives Auto Job Follow-ups? (True/False),Client Receives Auto Quote Follow-ups? (True/False),Client Receives Auto Invoice Follow-ups? (True/False),Client Receives Auto Review Requests? (True/False),Quote Number,Quote Title,Quote Status (Draft/Awaiting Response/Approved),Quote Message,Quote Internal Note,Quote Introduction Title,Quote Introduction Body,Quote Contract Disclaimer,Quote Discount Type (Unit/Percentage),Quote Discount Amount (Unit/Percentage),Quote Deposit Type (Unit/Percentage),Quote Deposit Amount (Unit/Percentage),Quote New Tax Rate Name,Quote New Tax Rate (Percentage),Quote Existing Tax Rate Name,Tax Method (Inclusive/Exclusive)" +
    Array.from({ length: 10 }, (_, i) => `,Line Item ${i + 1} Category (Service/Product),Line Item ${i + 1} Name,Line Item ${i + 1} Description,Line Item ${i + 1} Quantity,Line Item ${i + 1} UNIT Price,Line Item ${i + 1} UNIT Cost,Line Item ${i + 1} Taxable (True/False)`).join(""),
  invoices:
    "Jobber Client ID,Client Title,Client First Name,Client Last Name,Client Full Name (Display Only),Client Company Name,Client Is a Company? (True/False),Client Email,Client Main Phone,Client Home Phone,Client Work Phone,Client Mobile Phone,Client Fax Phone,Client Other Phone,Client SMS Enabled Phone Number,Jobber Property ID,Property Street 1,Property Street 2,Property City,Property State/Province,Property Zip/Postal Code,Property Country,Billing Street 1,Billing Street 2,Billing City,Billing State/Province,Billing Zip/Postal Code,Billing Country,Client Receives Auto Visit Reminders? (True/False),Client Receives Auto Job Follow-ups? (True/False),Client Receives Auto Quote Follow-ups? (True/False),Client Receives Auto Invoice Follow-ups? (True/False),Client Receives Auto Review Requests? (True/False),Invoice Number,Invoice Subject,Invoice Status (Draft/Sent/Paid),Invoice Issued Date,Invoice Due Date,Invoice Discount Type (Unit/Percentage),Invoice Discount Amount (Unit/Percentage),Invoice New Tax Rate Name,Invoice New Tax Rate (Percentage),Invoice Existing Tax Rate Name,Tax Method (Inclusive/Exclusive),Invoice Internal Note" +
    Array.from({ length: 10 }, (_, i) => `,Line Item ${i + 1} Category (Service/Product),Line Item ${i + 1} Name,Line Item ${i + 1} Description,Line Item ${i + 1} Quantity,Line Item ${i + 1} TOTAL Price,Line Item ${i + 1} Taxable (True/False)`).join(""),
  jobs: "Job Title,Instructions,Job Number,Client Name,Client Phone Number,Client Email,Full Property Address,Street1,Street2,City,State,Zip,Country,Start Date,Start Time,End Time,Repeating,Duration Length,Duration Unit,How do you want to invoice?,When do you want to invoice?,Assigned To,Total Price",
  clients:
    "Client Created Date,Client Is Company?,Client Title,Client First Name,Client Last Name,Client Full Name (Display Only),Client Company Name,Client Email,Client Main Phone,Client Home Phone,Client Work Phone,Client Mobile Phone,Client Fax Phone,Client Other Phone,Client SMS Enabled Phone Number,Property Street 1,Property Street 2,Property City,Property State/Province,Property Zip/Postal Code,Property Country,Billing Street 1,Billing Street 2,Billing City,Billing State/Province,Billing Zip/Postal Code,Billing Country,Client Receives Auto Visit Reminders? (True/False),Client Receives Auto Job Follow-ups? (True/False),Client Receives Auto Quote Follow-ups? (True/False),Client Receives Auto Invoice Follow-ups? (True/False),Archived (True/False),Account Balance,Client Internal Notes,Lead Source,Tags",
};

const line = (name: string, quantity: number, unit_price: number, taxable = true, unit_cost: number | null = null): JobberLine => ({ name, description: null, quantity, unit_price, unit_cost, taxable });

const quote = (q: Partial<JobberQuote> & Pick<JobberQuote, "client_id" | "number" | "status">): JobberQuote => ({
  property_id: null, title: `Quote ${q.number}`, message: null, discount_amount: 0, deposit_amount: 0, tax_rate: 0, sent_at: null, approved_at: null, option: null, lines: [line("Mowing", 1, 50)], ...q,
});
const job = (j: Partial<JobberJob> & Pick<JobberJob, "client_id" | "number" | "kind" | "status">): JobberJob => ({
  property_id: null, title: `Job ${j.number}`, instructions: null, starts_on: null, ends_on: null, recurrence_rule: null, active_months: null,
  billing_mode: "on_completion", visit_start_time: null, visit_duration_min: 60, lines: [], visits: [], ...j,
});

const INPUT: JobberInput = {
  timeZone: "America/New_York",
  today: "2026-10-26",
  clients: [
    { id: "c1", display_name: "Mary Ann Smith", company_name: null, email: "mary@example.com", phone: "540-555-0101", status: "active", lead_source: "Yard sign", tags: ["Weekly"], notes: "Gate code 1234", created_at: "2025-03-04T15:00:00Z", billing_address: { line1: "PO Box 9", city: "Roanoke", region: "VA", postal_code: "24011" } },
    { id: "c2", display_name: "Acme Paving", company_name: "Acme Paving", email: null, phone: null, status: "archived", lead_source: "Google Maps", tags: [], notes: null, created_at: "2024-01-02T15:00:00Z", billing_address: {} },
    { id: "c3", display_name: "Lee", company_name: null, email: "lee@example.com", phone: "+15405550199", status: "lead", lead_source: null, tags: [], notes: null, created_at: "2026-10-01T15:00:00Z", billing_address: null },
  ],
  contacts: [{ client_id: "c1", name: "Tom Smith", role: "Spouse", email: "tom@example.com", phone: "5405550102" }],
  properties: [
    { id: "p1", client_id: "c1", line1: "12 Oak St", line2: null, city: "Roanoke", region: "VA", postal_code: "24011", country: "US" },
    { id: "p2", client_id: "c1", line1: "40 Elm Ave", line2: "Unit 2", city: "Salem", region: "VA", postal_code: "24153", country: "US" },
    { id: "p3", client_id: "c3", line1: "7 Pine Rd", line2: null, city: "Vinton", region: "VA", postal_code: "24179", country: "US" },
  ],
  quotes: [
    quote({ client_id: "c1", property_id: "p2", number: 3, status: "approved", option: "Best", discount_amount: 10, deposit_amount: 50, tax_rate: 0.0825, sent_at: "2026-09-01T14:00:00Z", approved_at: "2026-09-04T14:00:00Z", lines: [line("Sealcoat", 1200, 0.25, true, 0.1), line("Crack fill", 1, 150, false)] }),
    quote({ client_id: "c1", number: 4, status: "lost" }),
    quote({ client_id: "c3", property_id: "p3", number: 5, status: "sent", lines: Array.from({ length: 12 }, (_, i) => line(`Item ${i + 1}`, 1, 10, i % 2 === 0)) }),
    quote({ client_id: "c2", number: 6, status: "draft" }),
  ],
  jobs: [
    job({
      client_id: "c1", property_id: "p1", number: 10, kind: "one_off", status: "active", lines: [line("Mulch", 2, 100), line("Edging", 1, 49.99)],
      visits: [
        { date: "2026-10-20", starts_at: null, ends_at: null, status: "completed", people: [] },
        { date: "2026-11-02", starts_at: "2026-11-02T13:00:00Z", ends_at: "2026-11-02T15:30:00Z", status: "scheduled", people: ["Ana Diaz", "Bo Lee"] },
        { date: "2026-11-09", starts_at: null, ends_at: null, status: "scheduled", people: [] },
      ],
    }),
    job({ client_id: "c3", property_id: "p3", number: 11, kind: "recurring", status: "active", starts_on: "2026-04-07", recurrence_rule: "FREQ=WEEKLY;INTERVAL=1;BYDAY=TU", visit_start_time: "08:00:00", visit_duration_min: 45, billing_mode: "per_visit", lines: [line("Mowing", 1, 45)] }),
    job({ client_id: "c1", property_id: "p1", number: 2, kind: "one_off", status: "completed", billing_mode: "per_visit", visits: [{ date: "2025-06-01", starts_at: null, ends_at: null, status: "completed", people: [] }] }),
    job({ client_id: "c1", property_id: "p1", number: 12, kind: "recurring", status: "active", starts_on: "2026-10-01", recurrence_rule: "FREQ=WEEKLY;INTERVAL=3;BYDAY=TH", active_months: [4, 5, 6, 7, 8, 9, 10], instructions: "Back gate." }),
    job({ client_id: "c2", number: 13, kind: "one_off", status: "active" }),
    job({ client_id: "c1", property_id: "p1", number: 1, kind: "one_off", status: "archived", starts_on: "2015-01-01" }),
    job({
      client_id: "c3", property_id: "p3", number: 8, kind: "recurring", status: "completed", starts_on: "2026-05-05", ends_on: "2026-06-30", recurrence_rule: "FREQ=WEEKLY;BYDAY=TU", billing_mode: "per_visit",
      visits: [{ date: "2026-05-05", starts_at: null, ends_at: null, status: "completed", people: [] }, { date: "2026-06-30", starts_at: null, ends_at: null, status: "completed", people: [] }],
    }),
  ],
  invoices: [
    { client_id: "c1", property_id: "p1", number: 20, subject: "Fall cleanup", status: "paid", issued_on: "2026-10-01", due_on: "2026-10-31", discount_amount: 0, tax_rate: 0, total: 75, amount_paid: 75, balance_due: 0, retainage_amount: 0, notes: null, lines: [line("Bags of leaves", 3, 25)] },
    { client_id: "c1", property_id: null, number: 21, subject: null, status: "partially_paid", issued_on: "2026-10-05", due_on: null, discount_amount: 0, tax_rate: 0.05, total: 200, amount_paid: 50, balance_due: 150, retainage_amount: 1234.5, notes: "Thanks!", lines: [line("Patio", 1, 190.48)] },
    { client_id: "c3", property_id: null, number: 22, subject: null, status: "void", issued_on: "2026-10-06", due_on: null, discount_amount: 0, tax_rate: 0, total: 10, amount_paid: 0, balance_due: 0, retainage_amount: 0, notes: null, lines: [] },
  ],
};

describe("moving to Jobber", () => {
  it("uses Jobber's sample files' column names: the same, in order, for quotes, jobs and invoices", () => {
    expect(JOBBER_COLUMNS.quotes.join(",")).toBe(SAMPLE_HEADERS.quotes);
    expect(JOBBER_COLUMNS.invoices.join(",")).toBe(SAMPLE_HEADERS.invoices);
    expect(JOBBER_COLUMNS.jobs.join(",")).toBe(SAMPLE_HEADERS.jobs);
    // The client import matches columns by name, so the clients file has just the ones it fills.
    const clientSample = SAMPLE_HEADERS.clients.split(",");
    expect(JOBBER_COLUMNS.clients.filter((c) => !clientSample.includes(c))).toEqual([]);
  });

  it("splits names the way Jobber keeps them", () => {
    expect(jobberName({ display_name: "Mary Ann Smith", company_name: null })).toEqual({ first: "Mary Ann", last: "Smith", company: "", isCompany: false });
    expect(jobberName({ display_name: "John Smith Jr.", company_name: null })).toMatchObject({ first: "John", last: "Smith Jr." });
    expect(jobberName({ display_name: "Cher", company_name: null })).toMatchObject({ first: "Cher", last: "" });
    expect(jobberName({ display_name: "Acme Paving", company_name: "ACME paving" })).toEqual({ first: "", last: "", company: "ACME paving", isCompany: true });
    expect(jobberName({ display_name: "Jane Doe", company_name: "Doe LLC" })).toEqual({ first: "Jane", last: "Doe", company: "Doe LLC", isCompany: false });
    // A business's name isn't split like a person's, with its company name or without one.
    expect(jobberName({ display_name: "Summit Ridge Builders", company_name: "Summit Ridge Builders LLC" })).toEqual({ first: "", last: "", company: "Summit Ridge Builders LLC", isCompany: true });
    expect(jobberName({ display_name: "Town of Rocky Mount", company_name: "Town of Rocky Mount Public Works" })).toMatchObject({ company: "Town of Rocky Mount Public Works", isCompany: true });
    expect(jobberName({ display_name: "Meadowbrook HOA", company_name: null })).toEqual({ first: "", last: "", company: "Meadowbrook HOA", isCompany: true });
    expect(jobberName({ display_name: "Charlotte Church", company_name: null })).toMatchObject({ first: "Charlotte", last: "Church", isCompany: false });
    expect(jobberName({ display_name: "Jane Doe", company_name: "Jane Doe Landscaping" })).toMatchObject({ first: "Jane", last: "Doe", isCompany: false });
  });

  it("gives every lead source one of Jobber's, and countries their names", () => {
    expect(["Google", "referral", "Repeat client", "Facebook ad", "Door hanger", "Truck wrap", "Yard sign", "", null].map(jobberLeadSource)).toEqual([
      "Google", "Referral", "Referral", "Facebook", "Flyer", "Vehicle Wrap", "Other", "", "",
    ]);
    expect([countryName("US"), countryName("ca"), countryName("United States"), countryName(null)]).toEqual(["United States", "Canada", "United States", ""]);
  });

  it("knows the repeats Jobber's job import does", () => {
    expect(jobberRepeat("FREQ=WEEKLY;INTERVAL=1;BYDAY=TU")).toBe("Weekly");
    expect(jobberRepeat("FREQ=WEEKLY;INTERVAL=2;BYDAY=FR")).toBe("BiWeekly");
    expect(jobberRepeat("FREQ=MONTHLY;INTERVAL=1;BYMONTHDAY=15")).toBe("Monthly");
    expect(jobberRepeat("FREQ=WEEKLY;INTERVAL=1;BYDAY=TU,TH")).toBeNull();
    expect(jobberRepeat("FREQ=WEEKLY;INTERVAL=3;BYDAY=TU")).toBeNull();
    expect(jobberRepeat("FREQ=MONTHLY;BYDAY=2TU")).toBeNull();
    expect(jobberRepeat(null)).toBeNull();
  });

  it("adds up lines past ten into one, or two when some are taxed and some aren't, keeping the total", () => {
    const lines = Array.from({ length: 13 }, (_, i) => line(`Item ${i + 1}`, 2, 10.25, i % 2 === 0));
    const fitted = fitLines(lines);
    expect(fitted).toHaveLength(10);
    expect(fitted.slice(0, 8).map((l) => l.name)).toEqual(lines.slice(0, 8).map((l) => l.name));
    expect(fitted.slice(8).map((l) => [l.name, l.taxable, l.unit_price])).toEqual([["3 more items", true, 61.5], ["2 more items", false, 41]]);
    expect(fitted[8].description).toBe("2 x Item 9; 2 x Item 11; 2 x Item 13");
    const sameTax = fitLines(Array.from({ length: 11 }, (_, i) => line(`Item ${i + 1}`, 1, 5)));
    expect(sameTax.map((l) => l.name).slice(8)).toEqual(["Item 9", "2 more items"]);
    expect(fitLines(lines.slice(0, 10))).toEqual(lines.slice(0, 10));
  });

  const result = jobberExport(INPUT);
  const file = (prefix: string) => result.files.find((f) => f.name.startsWith(prefix))!;

  it("writes a client row for each property, and a company or a person as Jobber does", () => {
    const rows = file("1-clients").rows;
    expect(file("1-clients").name).toBe("1-clients.csv");
    expect(rows.map((r) => [r["Client Full Name (Display Only)"], r["Property Street 1"]])).toEqual([
      ["Acme Paving", ""], ["Lee", "7 Pine Rd"], ["Mary Ann Smith", "12 Oak St"], ["Mary Ann Smith", "40 Elm Ave"],
    ]);
    expect(rows[2]).toMatchObject({
      "Client Created Date": "3/4/2025", "Client Is Company?": "FALSE", "Client First Name": "Mary Ann", "Client Last Name": "Smith", "Client Main Phone": "(540) 555-0101",
      "Property Country": "United States", "Billing Street 1": "PO Box 9", "Billing Country": "United States", "Archived (True/False)": "FALSE",
      "Client Internal Notes": "Gate code 1234\n\nOther contacts: Tom Smith (Spouse) tom@example.com (540) 555-0102", "Lead Source": "Other", "Tags": "Weekly",
    });
    expect(rows[0]).toMatchObject({ "Client Is Company?": "TRUE", "Client First Name": "", "Client Company Name": "Acme Paving", "Archived (True/False)": "TRUE", "Lead Source": "Google", "Billing Country": "" });
    expect(rows[1]).toMatchObject({ "Client First Name": "Lee", "Client Main Phone": "(540) 555-0199", "Tags": "Lead" });
  });

  it("writes quotes Jobber has a status for, with their lines, tax, discount and deposit", () => {
    const rows = file("2-quotes").rows;
    expect(rows.map((r) => r["Quote Number"])).toEqual([3, 5]);
    expect(rows[0]).toMatchObject({
      "Client First Name": "Mary Ann", "Client Email": "mary@example.com", "Property Street 1": "40 Elm Ave", "Property Street 2": "Unit 2",
      "Quote Status (Draft/Awaiting Response/Approved)": "Approved", "Quote Internal Note": "From Crewtavo. Option: Best. Sent Sep 1, 2026. Approved Sep 4, 2026.",
      "Quote Discount Type (Unit/Percentage)": "Unit", "Quote Discount Amount (Unit/Percentage)": 10, "Quote Deposit Amount (Unit/Percentage)": 50,
      "Quote New Tax Rate Name": "Sales tax (8.25%)", "Quote New Tax Rate (Percentage)": "8.25", "Tax Method (Inclusive/Exclusive)": "Exclusive",
      "Line Item 1 Name": "Sealcoat", "Line Item 1 Quantity": 1200, "Line Item 1 UNIT Price": 0.25, "Line Item 1 UNIT Cost": 0.1, "Line Item 1 Taxable (True/False)": "TRUE",
      "Line Item 2 Name": "Crack fill", "Line Item 2 UNIT Cost": "", "Line Item 2 Taxable (True/False)": "FALSE",
      "Client Receives Auto Quote Follow-ups? (True/False)": "FALSE",
    });
    expect(rows[1]["Quote Status (Draft/Awaiting Response/Approved)"]).toBe("Awaiting Response");
    expect(rows[1]["Line Item 10 Name"]).toMatch(/more items$/);
    expect(Object.keys(rows[1]).every((k) => JOBBER_COLUMNS.quotes.includes(k))).toBe(true);
  });

  it("writes running jobs from their next visit and finished ones as history, never to invoice", () => {
    const rows = file("3-jobs").rows;
    expect(rows.map((r) => r["Job Number"])).toEqual([2, 8, 10, 11, 12]);
    const byNumber = (n: number) => rows.find((r) => r["Job Number"] === n)!;
    expect(byNumber(10)).toMatchObject({
      "Client Name": "Mary Ann Smith", "Street1": "12 Oak St", "Country": "United States", "Start Date": "Nov 2, 2026", "Start Time": "8:00 AM", "End Time": "10:30 AM",
      "Repeating": "DoesNotRepeat", "Duration Length": "", "How do you want to invoice?": "One price", "When do you want to invoice?": "On complete",
      "Assigned To": "Ana Diaz, Bo Lee", "Total Price": "249.99",
    });
    expect(byNumber(11)).toMatchObject({
      "Start Date": "Oct 27, 2026", "Start Time": "8:00 AM", "End Time": "8:45 AM", "Repeating": "Weekly", "Duration Length": "365", "Duration Unit": "days",
      "How do you want to invoice?": "Per visit", "When do you want to invoice?": "Per visit", "Total Price": "45.00",
    });
    expect(byNumber(2)).toMatchObject({ "Start Date": "Jun 1, 2025", "How do you want to invoice?": "One price", "When do you want to invoice?": "Never" });
    expect(byNumber(8)).toMatchObject({ "Start Date": "May 5, 2026", "Repeating": "Weekly", "Duration Length": "57", "When do you want to invoice?": "Never" });
    expect(byNumber(12)["Repeating"]).toBe("AsNeeded");
    expect(byNumber(12)["Instructions"]).toBe("Back gate.\n\nRepeats every 3 weeks on Thursday in Crewtavo.\n\nIn season Apr, May, Jun, Jul, Aug, Sep, Oct.");
  });

  it("writes invoices with their lines' totals, and payments as a note", () => {
    const rows = file("4-invoices").rows;
    expect(rows.map((r) => r["Invoice Number"])).toEqual([20, 21]);
    expect(rows[0]).toMatchObject({
      "Invoice Subject": "Fall cleanup", "Invoice Status (Draft/Sent/Paid)": "Paid", "Invoice Issued Date": "2026-10-01", "Invoice Due Date": "2026-10-31",
      "Property Street 1": "12 Oak St", "Line Item 1 Quantity": 3, "Line Item 1 TOTAL Price": 75,
    });
    expect(rows[1]).toMatchObject({
      "Invoice Subject": "Invoice 21", "Invoice Status (Draft/Sent/Paid)": "Sent", "Invoice New Tax Rate Name": "Sales tax (5%)", "Invoice New Tax Rate (Percentage)": "5",
      "Invoice Internal Note": "Paid $50.00 of $200.00 in Crewtavo; $150.00 left. Record the payment in Jobber.\n\nRetainage held: $1,234.50.\n\nThanks!",
    });
  });

  it("puts referral credits into Jobber's one discount", () => {
    const credited = jobberExport({ ...INPUT, invoices: [{ ...INPUT.invoices[0]!, discount_amount: 5, credit_amount: 20.5 }] });
    expect(credited.files.find((f) => f.name.startsWith("4-invoices"))!.rows[0]).toMatchObject({
      "Invoice Discount Type (Unit/Percentage)": "Unit", "Invoice Discount Amount (Unit/Percentage)": 25.5,
    });
  });

  it("says what stays out or comes in differently", () => {
    expect(result.counts).toEqual({ clients: 3, properties: 3, quotes: 2, jobs: 5, invoices: 2 });
    const notes = result.notes.join("\n");
    expect(notes).toContain("1 lost or archived quote isn't in the quotes file");
    expect(notes).toContain("1 quote for clients without an address isn't");
    expect(notes).toContain("1 job without an address isn't");
    expect(notes).toContain("1 job that started more than ten years ago isn't");
    expect(notes).toContain("1 void or written-off invoice isn't");
    expect(notes).toContain("1 partly paid invoice comes in as sent");
    expect(notes).toContain('1 recurring job that doesn\'t repeat weekly, every two weeks or monthly comes in as "as needed"');
    expect(notes).toContain("1 quote or invoice with more than 10 lines has the rest added up");
    expect(notes).toContain("1 one-off job with more than one visit still to come comes in with the next visit only");
    const readme = jobberReadme(result);
    expect(readme).toContain("1. Clients and properties (3 clients, 3 properties): 1-clients.csv");
    expect(readme).toContain("4. Invoices (2 invoices): 4-invoices.csv");
    expect(readme).toContain("- Jobber's invoice import has no payments. Paid invoices come in as paid. 1 partly paid invoice");
  });

  it("splits a file at Jobber's limit", () => {
    const many = jobberExport({ ...INPUT, quotes: Array.from({ length: 501 }, (_, i) => quote({ client_id: "c3", property_id: "p3", number: i + 1, status: "draft" })) });
    expect(many.files.filter((f) => f.name.startsWith("2-quotes")).map((f) => [f.name, f.rows.length])).toEqual([["2-quotes-part-1.csv", 500], ["2-quotes-part-2.csv", 1]]);
    expect(jobberReadme(many)).toContain("2-quotes-part-1.csv, 2-quotes-part-2.csv");
    // The client import takes 2.5 MB a file: long notes split it sooner than its row limit.
    const notes = "n".repeat(1000);
    const big = jobberExport({ ...INPUT, clients: Array.from({ length: 2500 }, (_, i) => ({ ...INPUT.clients[2], id: `x${i}`, display_name: `Client ${i}`, notes })) });
    const parts = big.files.filter((f) => f.name.startsWith("1-clients"));
    expect(parts.map((f) => f.name)).toEqual(["1-clients-part-1.csv", "1-clients-part-2.csv"]);
    expect(parts.reduce((n, f) => n + f.rows.length, 0)).toBe(2500);
    expect(parts[0].rows.length).toBeLessThan(2000);
  });
});
