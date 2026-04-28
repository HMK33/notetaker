import { useState, useEffect, useCallback } from "react";
import {
  getTeamMembers,
  addTeamMember as dbAdd,
  updateTeamMember as dbUpdate,
  deleteTeamMember as dbDelete,
} from "../services/database";
import type { TeamMember } from "../types";

export function useTeamMembers() {
  const [members, setMembers] = useState<TeamMember[]>([]);
  const [loading, setLoading] = useState(true);

  const reload = useCallback(async () => {
    try {
      setMembers(await getTeamMembers());
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    reload();
  }, [reload]);

  const add = useCallback(
    async (name: string, role: string | null) => {
      const m = await dbAdd(name, role);
      setMembers((prev) => [...prev, m]);
      return m;
    },
    []
  );

  const update = useCallback(
    async (id: string, name: string, role: string | null) => {
      await dbUpdate(id, name, role);
      setMembers((prev) =>
        prev.map((m) => (m.id === id ? { ...m, name, role } : m))
      );
    },
    []
  );

  const remove = useCallback(async (id: string) => {
    await dbDelete(id);
    setMembers((prev) => prev.filter((m) => m.id !== id));
  }, []);

  return { members, loading, add, update, remove, reload };
}
