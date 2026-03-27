(function () {
  "use strict";

  const grid = document.getElementById("projectGrid");
  const addBtn = document.getElementById("addProjectBtn");
  const modal = document.getElementById("addModal");
  const pathInput = document.getElementById("projectPathInput");
  const cancelBtn = document.getElementById("addCancelBtn");
  const confirmBtn = document.getElementById("addConfirmBtn");

  async function loadProjects() {
    try {
      const res = await fetch("/api/projects");
      const projects = await res.json();
      renderProjects(projects);
    } catch (err) {
      grid.innerHTML = '<div class="loading">Failed to load projects</div>';
    }
  }

  function renderProjects(projects) {
    if (projects.length === 0) {
      grid.innerHTML =
        '<div class="empty-state">' +
        "<p>No projects found. Add a project manually or use Claude Code CLI to create sessions.</p>" +
        '</div>';
      return;
    }

    grid.innerHTML = projects
      .map(function (p) {
        var badges = "";
        if (p.hasGit) badges += '<span class="badge badge-git">Git</span>';
        if (p.hasClaude) badges += '<span class="badge badge-claude">Claude</span>';

        var meta = "";
        if (p.sessionCount > 0) {
          meta += '<span class="project-sessions">' + p.sessionCount + ' session' + (p.sessionCount > 1 ? 's' : '') + '</span>';
        }
        if (p.lastModified > 0) {
          meta += '<span class="project-time">' + timeAgo(p.lastModified) + '</span>';
        }

        return (
          '<div class="project-card" data-path="' + escapeAttr(p.path) + '">' +
          '<div class="project-name">' + escapeHtml(p.name) + "</div>" +
          '<div class="project-path">' + escapeHtml(p.path) + "</div>" +
          '<div class="project-meta">' + meta + "</div>" +
          '<div class="project-badges">' + badges + "</div>" +
          "</div>"
        );
      })
      .join("");

    // Attach click handlers
    var cards = grid.querySelectorAll(".project-card");
    cards.forEach(function (card) {
      card.addEventListener("click", function () {
        var path = card.getAttribute("data-path");
        window.location.href = "/chat?project=" + btoa(path);
      });
    });
  }

  function escapeHtml(str) {
    var div = document.createElement("div");
    div.textContent = str;
    return div.innerHTML;
  }

  function escapeAttr(str) {
    return str.replace(/&/g, "&amp;").replace(/"/g, "&quot;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
  }

  function timeAgo(timestamp) {
    var now = Date.now();
    var diff = now - timestamp;
    var seconds = Math.floor(diff / 1000);
    var minutes = Math.floor(seconds / 60);
    var hours = Math.floor(minutes / 60);
    var days = Math.floor(hours / 24);

    if (days > 0) return days + 'd ago';
    if (hours > 0) return hours + 'h ago';
    if (minutes > 0) return minutes + 'm ago';
    return 'just now';
  }

  // Modal
  addBtn.addEventListener("click", function () {
    modal.style.display = "flex";
    pathInput.value = "";
    pathInput.focus();
  });

  cancelBtn.addEventListener("click", function () {
    modal.style.display = "none";
  });

  confirmBtn.addEventListener("click", async function () {
    var path = pathInput.value.trim();
    if (!path) return;
    try {
      await fetch("/api/projects", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ path: path }),
      });
      modal.style.display = "none";
      loadProjects();
    } catch (err) {
      alert("Failed to add project");
    }
  });

  pathInput.addEventListener("keydown", function (e) {
    if (e.key === "Enter") confirmBtn.click();
    if (e.key === "Escape") cancelBtn.click();
  });

  modal.addEventListener("click", function (e) {
    if (e.target === modal) modal.style.display = "none";
  });

  // Initial load
  loadProjects();
})();
