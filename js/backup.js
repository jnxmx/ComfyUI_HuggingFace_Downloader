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
				padding: "30px", // Increased padding
				borderRadius: "8px",
				minWidth: "480px", // Increased width
				display: "flex",
				flexDirection: "column",
				gap: "16px", // Increased gap
				boxShadow: "0 6px 16px rgba(0,0,0,0.5)", // Slightly stronger shadow
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
				justifyContent: "space-between", // Adjusted for grouped buttons
				gap: "8px",
			});

			// Cancel button
			const cancelButton = document.createElement("button");
			cancelButton.textContent = "Cancel";
			cancelButton.className = "p-button p-component p-button-secondary"; // PrimeVue styling
			cancelButton.onclick = () => {
				dlg.style.display = "none";
			};
			btnRow.appendChild(cancelButton);

			// Grouped buttons (Upload and Restore)
			const actionGroup = document.createElement("div");
			Object.assign(actionGroup.style, {
				display: "flex",
				gap: "8px",
			});

			// Upload button
			const uploadButton = document.createElement("button");
			uploadButton.textContent = "Backup";
			uploadButton.className = "p-button p-component p-button-success"; // PrimeVue styling
			uploadButton.onclick = () => {
				console.log("Backup upload clicked", ta.value);
				// TODO: call actual upload routine here
				dlg.style.display = "none";
			};
			actionGroup.appendChild(uploadButton);

			// Restore button
			const restoreButton = document.createElement("button");
			restoreButton.textContent = "Download";
			restoreButton.className = "p-button p-component p-button-info"; // PrimeVue styling
			restoreButton.onclick = () => {
				console.log("Backup restore clicked", ta.value);
				// TODO: call actual restore routine here
				dlg.style.display = "none";
			};
			actionGroup.appendChild(restoreButton);

			btnRow.appendChild(actionGroup);

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