async function api(path, opts = {}) {
  const res = await fetch(path, {
    credentials: "include",
    headers: { "Content-Type": "application/json" },
    ...opts
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(data.error || "Request failed");
  return data;
}

const $ = (id) => document.getElementById(id);

async function refreshMe() {
  const { user } = await api("/api/me");
  $("me").textContent = user ? `${user.username} (${user.role})` : "";
  $("auth").classList.toggle("hidden", !!user);
  $("app").classList.toggle("hidden", !user);
  $("logout").classList.toggle("hidden", !user);
  return user;
}

async function loadAll() {
  const [{ content }, skillsRes, projectsRes] = await Promise.all([
    api("/api/admin/content"),
    api("/api/admin/skills"),
    api("/api/admin/projects"),
  ]);

  $("heroHeadline").value = content.hero_headline;
  $("heroSubtitle").value = content.hero_subtitle;

  renderSkills(skillsRes.skills);
  renderProjects(projectsRes.projects);
}

function renderSkills(skills) {
  const el = $("skillsList");
  el.innerHTML = "";
  skills.forEach(s => {
    const row = document.createElement("div");
    row.className = "row";
    row.innerHTML = `
      <div>
        <strong>${escapeHtml(s.label)}</strong>
        <div class="small">${s.percent}%</div>
      </div>
      <button class="btn ghost" data-del-skill="${s.id}">Delete</button>
    `;
    el.appendChild(row);
  });

  el.querySelectorAll("[data-del-skill]").forEach(btn => {
    btn.onclick = async () => {
      await api(`/api/admin/skills/${btn.dataset.delSkill}`, { method: "DELETE" });
      loadAll();
    };
  });
}

function renderProjects(projects) {
  const el = $("projectsList");
  el.innerHTML = "";
  projects.forEach(p => {
    const row = document.createElement("div");
    row.className = "row";
    row.innerHTML = `
      <div>
        <strong>${escapeHtml(p.title)}</strong>
        <div class="small">${escapeHtml(p.summary)}</div>
      </div>
      <button class="btn ghost" data-del-proj="${p.id}">Delete</button>
    `;
    el.appendChild(row);
  });

  el.querySelectorAll("[data-del-proj]").forEach(btn => {
    btn.onclick = async () => {
      await api(`/api/admin/projects/${btn.dataset.delProj}`, { method: "DELETE" });
      loadAll();
    };
  });
}

function escapeHtml(s) {
  return String(s).replace(/[&<>"']/g, m => ({
    "&":"&amp;","<":"&lt;",">":"&gt;",'"':"&quot;","'":"&#039;"
  }[m]));
}

// ---- events ----
$("login").onclick = async () => {
  $("authErr").textContent = "";
  try {
    await api("/api/login", {
      method: "POST",
      body: JSON.stringify({ username: $("u").value, password: $("p").value })
    });
    await refreshMe();
    await loadAll();
  } catch (e) {
    $("authErr").textContent = e.message;
  }
};

$("logout").onclick = async () => {
  await api("/api/logout", { method: "POST" });
  refreshMe();
};

$("saveHero").onclick = async () => {
  $("heroMsg").textContent = "";
  await api("/api/admin/content", {
    method: "PUT",
    body: JSON.stringify({
      hero_headline: $("heroHeadline").value,
      hero_subtitle: $("heroSubtitle").value
    })
  });
  $("heroMsg").textContent = "Saved";
  setTimeout(() => $("heroMsg").textContent = "", 1500);
};

$("addSkill").onclick = async () => {
  await api("/api/admin/skills", {
    method: "POST",
    body: JSON.stringify({
      label: $("skillLabel").value,
      percent: Number($("skillPercent").value || 0),
      sort: 0
    })
  });
  $("skillLabel").value = "";
  $("skillPercent").value = "";
  loadAll();
};

$("addProject").onclick = async () => {
  let links = [];
  try { links = JSON.parse($("projLinks").value || "[]"); } catch {}
  await api("/api/admin/projects", {
    method: "POST",
    body: JSON.stringify({
      title: $("projTitle").value,
      summary: $("projSummary").value,
      stack: $("projStack").value,
      links,
      featured: $("projFeatured").checked
    })
  });
  $("projTitle").value = "";
  $("projSummary").value = "";
  $("projStack").value = "";
  $("projLinks").value = "";
  $("projFeatured").checked = false;
  loadAll();
};

// boot
(async () => {
  const user = await refreshMe();
  if (user) await loadAll();
})();
