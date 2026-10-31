/**
 * The crew on their phones: work a visit from My day, and keep equipment hours and maintenance
 * current from the same screen.
 */
import { dateIn, expect, expectAccessible, makeJob, must, PHONE, test, unique, zonedIso, type Company } from "./support/fixtures";

/** A visit at 4 PM today, assigned to the demo employee. */
async function employeeVisitToday(data: Company) {
  const job = await makeJob(data, "Field");
  const today = dateIn(data.timezone);
  const visit = must(
    await data.db
      .from("visits")
      .insert({ company_id: data.id, job_id: job.id, property_id: job.client.propertyId, title: unique("Visit"), crew_id: job.crewId, scheduled_on: today, starts_at: zonedIso(today, "16:00", data.timezone), ends_at: zonedIso(today, "17:00", data.timezone) })
      .select("id, title")
      .single(),
    "visit",
  );
  must(await data.db.from("visit_assignees").insert({ company_id: data.id, visit_id: visit.id, user_id: await data.userId("employee") }).select("visit_id"), "assignee");
  return { job, visit };
}

test("a crew member works a visit from My day on a phone", async ({ as, data }) => {
  const { job, visit } = await employeeVisitToday(data);

  const page = await as("employee", PHONE);
  await page.goto("/field");
  await expect(page.getByRole("heading", { level: 1 })).toBeVisible();
  const card = page.getByRole("article").filter({ hasText: visit.title });
  await expect(card).toBeVisible();
  await expect(card).toContainText(job.client.name);
  await expectAccessible(page, "My day (phone)");

  // On the way, then started, from the card itself.
  await card.getByRole("button", { name: "On my way" }).click();
  await expect(card).toContainText("On the way");
  await card.getByRole("button", { name: "Start" }).click();
  await expect(card).toContainText("In progress");

  // Completed from the visit's own screen.
  await card.getByRole("link", { name: new RegExp(visit.title) }).click();
  await expect(page.getByRole("heading", { level: 1, name: visit.title })).toBeVisible();
  await expectAccessible(page, "a visit on a phone");
  const complete = page.getByRole("button", { name: "Complete visit" });
  await complete.click();
  // With required checklist items left, that tap showed the first one; tapped again, it offers to go without.
  if (await page.getByText(/required left/).isVisible().catch(() => false)) {
    await complete.click();
    await page.getByRole("button", { name: "Complete anyway" }).click();
  }
  await expect(page.getByText(/^Completed/).first()).toBeVisible();
  // The screen updates at once (it works offline); this message comes once the server has it.
  await expect(page.getByText("Visit completed")).toBeVisible();

  const done = must(await data.db.from("visits").select("status, completed_at").eq("id", visit.id).single(), "completed visit");
  expect(done.status).toBe("completed");
  expect(done.completed_at).toBeTruthy();
  // Starting and completing clocked the crew member in and out.
  const time = must(await data.db.from("time_entries").select("started_at, ended_at").eq("visit_id", visit.id).eq("user_id", await data.userId("employee")), "time entries");
  expect(time).toHaveLength(1);
  expect(time[0]!.ended_at).toBeTruthy();
});

test("a visit started on My day shows as started on its own screen while the tap is still sending", async ({ as, data }) => {
  const { visit } = await employeeVisitToday(data);
  const page = await as("employee", PHONE);
  await page.goto("/field");
  const card = page.getByRole("article").filter({ hasText: visit.title });
  await card.getByRole("button", { name: "On my way" }).click();
  await expect(page.getByText("On your way")).toBeVisible();

  // Hold the start on its way to the server, and open the visit meanwhile.
  let release!: () => void;
  const held = new Promise<void>((resolve) => (release = resolve));
  await page.route(`**/api/visits/${visit.id}`, async (route) => {
    if (route.request().method() === "PATCH") await held;
    await route.continue();
  });
  await card.getByRole("button", { name: "Start" }).click();
  await expect(card).toContainText("In progress");
  await card.getByRole("link", { name: new RegExp(visit.title) }).click();
  await expect(page.getByRole("heading", { level: 1, name: visit.title })).toBeVisible();
  await expect(page.getByRole("button", { name: "Complete visit" })).toBeVisible();

  release();
  await expect(page.getByText("Visit started, your clock is running")).toBeVisible();
  await expect(page.getByRole("button", { name: "Complete visit" })).toBeVisible();
  expect(must(await data.db.from("visits").select("status").eq("id", visit.id).single(), "visit").status).toBe("in_progress");
});

test("with no signal, My day and the visit's own screen agree, and the visit ends up started", async ({ as, data }) => {
  const { visit } = await employeeVisitToday(data);
  const page = await as("employee", PHONE);
  await page.goto("/field");
  const card = page.getByRole("article").filter({ hasText: visit.title });
  // Opened once with signal, so the phone has the visit. (The visit's screen loads on its own, so My
  // day, with its own "On my way" buttons, stays up until it has.)
  await card.getByRole("link", { name: new RegExp(visit.title) }).click();
  await expect(page.getByRole("heading", { level: 1, name: visit.title })).toBeVisible();
  await expect(page.getByRole("button", { name: "On my way" })).toBeVisible();
  await page.getByRole("link", { name: "My day" }).first().click();

  await page.context().setOffline(true);
  await card.getByRole("button", { name: "On my way" }).click();
  await card.getByRole("button", { name: "Start" }).click();
  await expect(card).toContainText("In progress");
  await card.getByRole("link", { name: new RegExp(visit.title) }).click();
  await expect(page.getByRole("button", { name: "Complete visit" })).toBeVisible();

  await page.context().setOffline(false);
  await expect(page.getByText("Visit started, your clock is running")).toBeVisible();
  await expect.poll(async () => must(await data.db.from("visits").select("status").eq("id", visit.id).single(), "visit").status).toBe("in_progress");
});

test("the foreman logs hours and marks maintenance done from My day on a phone", async ({ as, data }) => {
  const crewId = await data.crew("Paving crew");
  const name = unique("Mower");
  const mower = must(await data.db.from("equipment").insert({ company_id: data.id, name, kind: "mower", meter: "hours", meter_reading: 300, crew_id: crewId }).select("id").single(), "equipment");
  const plan = must(
    await data.db.from("equipment_plans").insert({ company_id: data.id, equipment_id: mower.id, name: "Grease the deck spindles", every_meter: 50, baseline_meter: 200, baseline_on: dateIn(data.timezone, -30) }).select("id").single(),
    "maintenance schedule",
  );

  const page = await as("foreman", PHONE);
  await page.goto("/field");
  await expect(page.getByRole("heading", { name: "Your equipment" })).toBeVisible();
  const row = page.locator("div", { has: page.getByRole("link", { name: new RegExp(name) }) }).filter({ has: page.getByRole("button", { name: "Log hours" }) }).last();
  await expect(row).toContainText("Overdue");
  await expectAccessible(page, "My day with equipment (phone)");

  // Today's hour meter reading.
  await row.getByRole("button", { name: "Log hours" }).click();
  const reading = page.getByRole("dialog", { name: "Update the reading" });
  await reading.getByLabel("Hour meter").fill("312");
  await expectAccessible(page, "the hour meter dialog");
  await reading.getByRole("button", { name: "Save" }).click();
  await expect(reading).toBeHidden();
  await expect(row).toContainText("312");

  // The overdue maintenance, done.
  await row.getByRole("button", { name: "Mark done" }).click();
  const service = page.getByRole("dialog", { name: "Log maintenance" });
  await expect(service.getByLabel("What was done")).toHaveValue(plan.id);
  await service.getByRole("button", { name: "Mark done" }).click();
  await expect(service).toBeHidden();
  await expect(row).not.toContainText("Overdue");

  const after = must(await data.db.from("equipment").select("meter_reading").eq("id", mower.id).single(), "equipment after");
  expect(Number(after.meter_reading)).toBe(312);
  const schedule = must(await data.db.from("equipment_due").select("state, last_done_meter, next_due_meter").eq("plan_id", plan.id).single(), "schedule after");
  expect(schedule).toMatchObject({ state: "ok", last_done_meter: 312, next_due_meter: 362 });
  const logs = must(await data.db.from("equipment_logs").select("kind, user_id").eq("equipment_id", mower.id).order("created_at"), "equipment history");
  expect(logs.map((l) => l.kind)).toEqual(["reading", "service"]);
  expect(new Set(logs.map((l) => l.user_id))).toEqual(new Set([await data.userId("foreman")]));
});
