import React from "react";
import { useWorkspace } from "./context.js";

export function TargetsPage() {
  const { targets, editingTargetId, setEditingTargetId, loadedTargetId, setLoadedTargetId, targetLoadFailed, setTargetLoadFailed, target, setTarget, setNotice, saveTarget } = useWorkspace();
  return (
          <section className="panel setup">
            <h2>
              <span>01</span> Target & identities
            </h2>
            <p className="hint">
              Saved usernames and external patient IDs load when you choose a
              target. Passwords remain encrypted and are never returned; leave
              them blank on update to keep the stored passwords.
            </p>
            <form
              onSubmit={(e) => {
                e.preventDefault();
                void saveTarget();
              }}
            >
              <label>
                Target to configure
                <select
                  value={editingTargetId}
                  onChange={(e) => {
                    const id = e.target.value;
                    const chosen = targets.find((t) => t.id === id);
                    setEditingTargetId(id);
                    setLoadedTargetId("");
                    setTargetLoadFailed(false);
                    setTarget({
                      name: chosen?.name ?? "Toy Co-Pilot",
                      baseUrl: chosen?.baseUrl ?? "",
                      aUser: "",
                      aPass: "",
                      aPubpid: "",
                      bUser: "",
                      bPass: "",
                      bPubpid: "",
                    });
                    setNotice("");
                  }}
                >
                  <option value="">Create new target</option>
                  {targets.map((t) => (
                    <option key={t.id} value={t.id}>
                      {t.name} - {t.baseUrl} ({t.id.slice(0, 8)})
                    </option>
                  ))}
                </select>
              </label>
              {editingTargetId && (
                <p role="status" className="credential-status">
                  {loadedTargetId === editingTargetId
                    ? "Saved passwords are stored securely and will be reused. Empty password boxes do not mean missing credentials."
                    : targetLoadFailed
                      ? "Could not load saved identities. Select another target and try again."
                      : "Loading saved identity details..."}
                </p>
              )}
              <label>
                Target name
                <input
                  required
                  value={target.name}
                  onChange={(e) =>
                    setTarget({ ...target, name: e.target.value })
                  }
                />
              </label>
              <label>
                OpenEMR base URL
                <input
                  type="url"
                  required
                  placeholder="http://toy-host:8080/"
                  value={target.baseUrl}
                  onChange={(e) =>
                    setTarget({ ...target, baseUrl: e.target.value })
                  }
                />
              </label>
              <div className="pair">
                {(["a", "b"] as const).map((u) => (
                  <div key={u}>
                    <h3>TEST USER {u.toUpperCase()}</h3>
                    <label>
                      Username
                      <input
                        required
                        autoComplete="off"
                        value={target[`${u}User`]}
                        onChange={(e) =>
                          setTarget({ ...target, [`${u}User`]: e.target.value })
                        }
                      />
                    </label>
                    <label>
                      {editingTargetId ? "New password (optional)" : "Password"}
                      <input
                        type="password"
                        required={!editingTargetId}
                        placeholder={
                          editingTargetId
                            ? "Leave blank to keep stored password"
                            : ""
                        }
                        autoComplete="new-password"
                        value={target[`${u}Pass`]}
                        onChange={(e) =>
                          setTarget({ ...target, [`${u}Pass`]: e.target.value })
                        }
                      />
                    </label>
                    <label>
                      External patient ID (pubpid)
                      <input
                        type="text"
                        pattern="[A-Za-z0-9-]{1,64}"
                        required
                        value={target[`${u}Pubpid`]}
                        onChange={(e) =>
                          setTarget({
                            ...target,
                            [`${u}Pubpid`]: e.target.value,
                          })
                        }
                      />
                    </label>
                  </div>
                ))}
              </div>
              <button
                disabled={
                  !!editingTargetId && loadedTargetId !== editingTargetId
                }
              >
                {editingTargetId ? "Update target" : "Create target"}
              </button>
            </form>
          </section>

  );
}
