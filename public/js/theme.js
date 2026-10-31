/* ==========================================================================
   THEME CONTROLLER (public/js/theme.js)
   ========================================================================== */

(function () {
    try {
        const savedTheme = localStorage.getItem("app_theme") || "dark";
        document.documentElement.setAttribute("data-theme", savedTheme);

        document.addEventListener("DOMContentLoaded", function () {
            const themeBtn = document.getElementById("themeToggleBtn");
            if (!themeBtn) return;

            function syncBtn(t) {
                themeBtn.innerHTML = t === "light" ? "🌙 Dark Mode" : "☀️ Light Mode";
            }

            syncBtn(savedTheme);

            themeBtn.addEventListener("click", function () {
                const current = document.documentElement.getAttribute("data-theme") || "dark";
                const target = current === "dark" ? "light" : "dark";
                document.documentElement.setAttribute("data-theme", target);
                localStorage.setItem("app_theme", target);
                syncBtn(target);
            });
        });
    } catch (e) {
        console.error("Theme switch error:", e);
    }
})();