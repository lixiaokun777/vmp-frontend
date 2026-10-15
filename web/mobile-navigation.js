let mobileNavigationOpen = false;
let mobileNavigationScroll = "";
const mobileNavigationQuery = window.matchMedia?.("(max-width: 580px)");

function setMobileNavigation(open, restoreFocus = true) {
  const toggle = document.querySelector("#mobile-menu-toggle");
  const drawer = document.querySelector("#mobile-navigation");
  const backdrop = document.querySelector("#mobile-nav-backdrop");
  if (!toggle || !drawer || !backdrop) return;
  open = Boolean(open && mobileNavigationQuery?.matches);
  const wasOpen = mobileNavigationOpen;
  mobileNavigationOpen = open;
  toggle.setAttribute("aria-expanded", String(open));
  toggle.setAttribute("aria-label", open ? "关闭导航菜单" : "打开导航菜单");
  drawer.classList.toggle("mobile-open", open);
  drawer.inert = Boolean(mobileNavigationQuery?.matches && !open);
  backdrop.hidden = !open;
  const main = document.querySelector(".shell > main");
  if (main) main.inert = open;
  if (open && !wasOpen) {
    mobileNavigationScroll = document.body.style.overflow;
    document.body.style.overflow = "hidden";
    requestAnimationFrame(() => { if (mobileNavigationOpen) drawer.querySelector("#mobile-nav-close")?.focus(); });
    drawer.addEventListener("transitionend", () => {
      if (mobileNavigationOpen && !drawer.contains(document.activeElement)) drawer.querySelector("#mobile-nav-close")?.focus();
    }, {once:true});
  } else if (!open && wasOpen) {
    document.body.style.overflow = mobileNavigationScroll;
    if (restoreFocus) toggle.focus();
  }
}
function bindMobileNavigation() {
  const toggle = document.querySelector("#mobile-menu-toggle");
  if (!toggle) return;
  toggle.onclick = () => setMobileNavigation(!mobileNavigationOpen);
  for (const id of ["#mobile-nav-backdrop", "#mobile-nav-close"]) {
    const button = document.querySelector(id); if (button) button.onclick = () => setMobileNavigation(false);
  }
  document.addEventListener("keydown", event => {
    if (!mobileNavigationOpen) return;
    if (event.key === "Escape") { event.preventDefault(); setMobileNavigation(false); }
    if (event.key === "Tab") {
      const controls = [...document.querySelectorAll("#mobile-navigation button")].filter(button => !button.disabled && !button.hidden && button.getClientRects().length);
      const first = controls[0], last = controls[controls.length - 1];
      if (!document.querySelector("#mobile-navigation").contains(document.activeElement)) { event.preventDefault(); first?.focus(); }
      else if (event.shiftKey && document.activeElement === first) { event.preventDefault(); last?.focus(); }
      else if (!event.shiftKey && document.activeElement === last) { event.preventDefault(); first?.focus(); }
    }
  });
  mobileNavigationQuery?.addEventListener("change", () => setMobileNavigation(false, false));
  setMobileNavigation(false, false);
}
bindMobileNavigation();
