import { app } from "../../../scripts/app.js";
import { python } from "../../../scripts/python.js"; // Use Python bridge to call backend functions

app.registerExtension({
	name: "myCustomExtension",
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

			 // Folder structure container
			const folderContainer = document.createElement("div");
			Object.assign(folderContainer.style, {
				maxHeight: "200px",
				overflowY: "auto",
				border: "1px solid #444",
				padding: "10px",
				borderRadius: "4px",
			});

			// Fetch all folders inside ComfyUI root directory (blocking)
			const folders = python("file_manager.get_all_subfolders_flat");

			// Create checkboxes for each folder
			const createCheckboxTree = (folder, parent) => {
				const checkbox = document.createElement("input");
				checkbox.type = "checkbox";
				checkbox.value = folder;
				checkbox.id = `folder-${folder}`;

				const label = document.createElement("label");
				label.textContent = folder;
				label.htmlFor = `folder-${folder}`;
				label.style.marginLeft = "8px";

				const container = document.createElement("div");
				container.style.marginLeft = "16px";
				container.appendChild(checkbox);
				container.appendChild(label);

				parent.appendChild(container);
			};

			folders.forEach((folder) => createCheckboxTree(folder, folderContainer));

			// Add folderContainer to panel
			panel.appendChild(folderContainer);

			// Buttons
			const btnRow = document.createElement("div");
			Object.assign(btnRow.style, {
				display: "flex",
				justifyContent: "flex-end",
				gap: "8px",
			});

			const backupButton = document.createElement("button");
			backupButton.textContent = "Backup";
			backupButton.onclick = () => {
				const selectedFolders = Array.from(
					folderContainer.querySelectorAll("input[type='checkbox']:checked")
				).map((checkbox) => checkbox.value);

				console.log("Selected folders for backup:", selectedFolders);
				// TODO: Call backup.py with selectedFolders
				dlg.style.display = "none";
			};

			btnRow.innerHTML = ""; // Clear existing buttons
			btnRow.appendChild(backupButton);

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