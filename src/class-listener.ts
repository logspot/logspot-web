// listen to class clicks starting with prefix lgspt-
// example: <div class="lgspt-imagine-cta">...</div>
// extract the name after the prefix
// split the name by dashes
// capitalize the first letter of each word
// join the words with spaces

const LOGSPOT_PREFIX = "lgspt-";

export const listenToClassClicks = (trackClick: (data: { name: string }) => void) => {
  document.addEventListener("click", (event) => {
    const target = event.target as HTMLElement;

    if (new RegExp(LOGSPOT_PREFIX).test(target.className) === false) {
      return;
    }

    const classes = target.className.split(" ");
    const classList = classes.filter((className) =>
      className.startsWith(LOGSPOT_PREFIX)
    );
    if (classList.length === 0) {
      return;
    }
    const className = classList[0];
    const name = className
      .replace(LOGSPOT_PREFIX, "")
      .split("-")
      .map((word) => word.charAt(0).toUpperCase() + word.slice(1))
      .join(" ");
    const payload = {
      name,
    };

    trackClick(payload);
  });
};
