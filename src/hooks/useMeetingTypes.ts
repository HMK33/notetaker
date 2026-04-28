import { useState, useEffect, useCallback } from "react";
import {
  getMeetingTypes,
  addMeetingType as dbAdd,
  deleteMeetingType as dbDelete,
} from "../services/database";
import type { MeetingType } from "../types";

export function useMeetingTypes() {
  const [types, setTypes] = useState<MeetingType[]>([]);
  const [loading, setLoading] = useState(true);

  const reload = useCallback(async () => {
    try {
      setTypes(await getMeetingTypes());
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    reload();
  }, [reload]);

  const add = useCallback(async (name: string) => {
    const t = await dbAdd(name);
    setTypes((prev) => [...prev, t]);
    return t;
  }, []);

  const remove = useCallback(async (id: string) => {
    await dbDelete(id);
    setTypes((prev) => prev.filter((t) => t.id !== id));
  }, []);

  return { types, loading, add, remove, reload };
}
