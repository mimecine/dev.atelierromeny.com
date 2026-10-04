// Shows the "Edit" link (Layout.astro) to whoever is signed in to Sveltia CMS in this
// browser: Sveltia keeps its login in localStorage ("sveltia-cms.user") on this site.
// Visitors never see it. Runs again after each client-side navigation.
function update() {
  const link = document.getElementById("cms-link");
  if (!link) return;
  let signedIn = false;
  try {
    const user = JSON.parse(localStorage.getItem("sveltia-cms.user") || "null");
    signedIn = !!user && (user.backendName === "local" || typeof user.token === "string");
  } catch {}
  link.hidden = !signedIn;
}

document.addEventListener("astro:page-load", update);
update();
