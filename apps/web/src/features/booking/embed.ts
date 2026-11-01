/**
 * Booking forms on the business's own website. The embed code is an iframe of the form with
 * ?embed=1 and a few lines of script for the website: inside the frame the form posts its height as
 * it changes (and asks to be brought into view once it's sent), and the script resizes the frame it
 * came from. Site builders that strip scripts still show the form, at a fixed height that scrolls.
 * The script also hands the page's ?promo= to the form (BookingFormPage reads it), so a link like
 * greenlawn.com/quote?promo=SPRING15 fills in the code.
 */

/** What the form posts to the page around it. */
export type EmbedMessage = { crewtavo: "height"; height: number } | { crewtavo: "top" };

/** The frame's height until the form says otherwise, or for good where scripts don't run. */
export const EMBED_HEIGHT = 900;

/**
 * Runs on the business's website. It only touches the frame a message came from, so it works with
 * several forms on one page, and still after Settings → Web address moves the form to a new address.
 * A sent form is scrolled to 100px below the top of the window, clear of a site's sticky header:
 * smoothly, unless the visitor asked their device for less motion.
 *
 * The page's ?promo= goes onto each form's link that has none, once: as the script starts, and again
 * on a form's first height message, so a form that appears after moving between pages of a site
 * (Next.js loads the script once) gets it too, with one reload at most. Site builders that put the
 * code in a frame of its own (Wix, GoDaddy, Google Sites) give it that frame's link, not the page's.
 */
export const EMBED_SCRIPT = `(function () {
  function promo(f) {
    var m = /[?&]promo=([^&#]*)/.exec(location.search);
    if (m && m[1] && !/[?&]promo=/.test(f.src)) f.src += (f.src.indexOf("?") < 0 ? "?" : "&") + "promo=" + m[1];
  }
  document.querySelectorAll("iframe[data-crewtavo-form]").forEach(promo);
  addEventListener("message", function (e) {
    document.querySelectorAll("iframe[data-crewtavo-form]").forEach(function (f) {
      if (f.contentWindow !== e.source || !e.data) return;
      if (e.data.crewtavo === "height" && e.data.height > 0) {
        f.style.height = Math.ceil(e.data.height) + "px";
        promo(f);
      }
      if (e.data.crewtavo === "top") {
        var top = f.getBoundingClientRect().top - 100;
        if (top < 0) scrollBy({ top: top, behavior: typeof matchMedia == "function" && matchMedia("(prefers-reduced-motion: reduce)").matches ? "auto" : "smooth" });
      }
    });
  });
})();`;

const attribute = (value: string) => value.replaceAll("&", "&amp;").replaceAll('"', "&quot;").replaceAll("<", "&lt;").replaceAll(">", "&gt;");

/** What to paste into the website: `url` is the form's link, `title` its name (read out by screen readers). */
export function embedCode(url: string, title: string): string {
  const frame = `<iframe src="${attribute(`${url}?embed=1`)}" title="${attribute(title)}" data-crewtavo-form style="display:block;width:100%;height:${EMBED_HEIGHT}px;border:0" loading="lazy"></iframe>`;
  return `${frame}\n<script>\n${EMBED_SCRIPT}\n</script>`;
}

/** A JSX attribute. JSX strings can't escape a quote and decode entities, so those get a JS string. */
const jsxAttribute = (value: string) => (/["&]/.test(value) ? `{${JSON.stringify(value)}}` : `"${value}"`);

/**
 * The same for a site built with Next.js, as a component (BookingForm.tsx or .jsx). JSX wants `style`
 * as an object and React doesn't run a <script> it renders, so the script goes through next/script:
 * its id loads it once however many forms a page has, and keeps it as people move between pages.
 * An Astro site takes embedCode() as it is. The website's docs page shows this too; keep them in step.
 */
export function nextEmbedCode(url: string, title: string): string {
  const script = EMBED_SCRIPT.split("\n").map((line) => `        ${line}`).join("\n");
  return [
    `import Script from "next/script";`,
    ``,
    `export function BookingForm() {`,
    `  return (`,
    `    <>`,
    `      <iframe`,
    `        src=${jsxAttribute(`${url}?embed=1`)}`,
    `        title=${jsxAttribute(title)}`,
    `        data-crewtavo-form=""`,
    `        loading="lazy"`,
    `        style={{ display: "block", width: "100%", height: ${EMBED_HEIGHT}, border: 0 }}`,
    `      />`,
    `      <Script id="crewtavo-forms" strategy="afterInteractive">{\``,
    script,
    `      \`}</Script>`,
    `    </>`,
    `  );`,
    `}`,
  ].join("\n");
}

/** Inside the frame: tell the website around it. Opened on its own, there's no one to tell. */
export function postToHost(message: EmbedMessage) {
  if (window.parent !== window) window.parent.postMessage(message, "*");
}
