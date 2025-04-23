import { app } from "../../../scripts/app.js";
import { api } from "../../../scripts/api.js";

/**
 * Minimal scaffold + “Backup ComfyUI to Hugging Face” dialog.
 * Flesh the guts out later: actual backup logic, HF auth, etc.
 */
app.registerExtension({
	name: "backupToHuggingFace", // Renamed extension
	setup() {

		/* ──────────────── D I A L O G ──────────────── */
		const showBackupDialog = () => {
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
			ta.value = `custom_nodes/ #Custom nodes folder
user/ #User settings and workflows folder
models/loras 
models/checkpoints/ #Below the size limit`; // Default content
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
				justifyContent: "space-between", // Adjusted for button layout
				gap: "8px",
			});

			// Cancel button
			const cancelButton = document.createElement("button");
			cancelButton.textContent = "Cancel";
			cancelButton.onclick = () => {
				dlg.style.display = "none";
			};
			btnRow.appendChild(cancelButton);

			// Upload button
			const uploadButton = document.createElement("button");
			uploadButton.textContent = "Backup";
			uploadButton.onclick = () => {
				console.log("Backup upload clicked", ta.value);
				// TODO: call actual upload routine here
				dlg.style.display = "none";
			};
			btnRow.appendChild(uploadButton);

			// Restore button
			const restoreButton = document.createElement("button");
			restoreButton.textContent = "Download";
			restoreButton.onclick = () => {
				console.log("Backup restore clicked", ta.value);
				// TODO: call actual restore routine here
				dlg.style.display = "none";
			};
			btnRow.appendChild(restoreButton);

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