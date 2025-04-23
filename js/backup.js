import { app } from "../../../scripts/app.js";
import { api } from "../../../scripts/api.js";
import fs from "fs";
import path from "path";

/**
 * Minimal scaffold + “Backup ComfyUI to Hugging Face” dialog.
 * Flesh the guts out later: actual backup logic, HF auth, etc.
 */
app.registerExtension({
	name: "myCustomExtension",
	setup() {

		/* ──────────────── D I A L O G ──────────────── */
		const showBackupDialog = () => {
			// Directly access the settings file
			const settingsPath = path.join("user", "default", "comfy.settings.json");
			let repoName = "";

			try {
				const settingsContent = fs.readFileSync(settingsPath, "utf-8");
				const settingsData = JSON.parse(settingsContent);
				repoName = settingsData?.downloaderbackup?.repo_name?.trim() || "";
			} catch (error) {
				console.error("Error reading settings file:", error);
			}

			if (!repoName) {
				alert("Please set up a repository for backup in the settings file first.");
				return;
			}

			// Keep just one instance alive
			let dlg = document.getElementById("backup-hf-dialog");
			if (dlg) {
				dlg.style.display = "flex";
				return;
			}

			// Overlay
			dlg = document.createElement("div");
			dlg.id = "backup-hf-dialog";
			Object.assign(dlg.style, {
				position: "fixed",
				top: 0,
				left: 0,
				width: "100vw",
				height: "100vh",
				display: "flex",
				alignItems: "center",
				justifyContent: "center",
				background: "rgba(0,0,0,0.5)",
				zIndex: 9999,
			});
			// Click outside panel to close
			dlg.addEventListener("click", (e) => {
				if (e.target === dlg) dlg.style.display = "none";
			});

			// Panel
			const panel = document.createElement("div");
			Object.assign(panel.style, {
				background: "#222",
				color: "#fff",
				padding: "20px",
				borderRadius: "8px",
				minWidth: "320px",
				display: "flex",
				flexDirection: "column",
				gap: "12px",
				boxShadow: "0 4px 12px rgba(0,0,0,0.4)",
			});

			// Multiline input
			const ta = document.createElement("textarea");
			ta.rows = 5;
			ta.placeholder = "Enter message for backup…";
			Object.assign(ta.style, {
				width: "100%",
				resize: "vertical",
				padding: "6px",
				borderRadius: "4px",
			});

			// Buttons
			const btnRow = document.createElement("div");
			Object.assign(btnRow.style, {
				display: "flex",
				justifyContent: "flex-end",
				gap: "8px",
			});

			["1", "2", "3"].forEach((label) => {
				const b = document.createElement("button");
				b.textContent = label;
				b.onclick = () => {
					console.log(`Backup button ${label} clicked`, ta.value);
					// TODO: call actual backup routine here
					dlg.style.display = "none";
				};
				btnRow.appendChild(b);
			});

			panel.appendChild(ta);
			panel.appendChild(btnRow);
			dlg.appendChild(panel);
			document.body.appendChild(dlg);
		};

		/* ─────────── Canvas-menu injection ─────────── */
		const origMenu = LGraphCanvas.prototype.getCanvasMenuOptions;
		LGraphCanvas.prototype.getCanvasMenuOptions = function () {
			const menu = origMenu.apply(this, arguments);

			menu.push(null, {
				content: "Backup ComfyUI to Hugging Face",
				callback: showBackupDialog,
			});

			return menu;
		};

		/* (Any other graph events you need) */
		// api.addEventListener("executing", ({ detail }) => { ... });
	},
});