import { useEffect, useCallback } from "react";
import { invoke } from "@tauri-apps/api/core";
import { useMeetingStore } from "../store/meetingStore";
import {
  getMeetings,
  deleteMeeting as dbDeleteMeeting,
} from "../services/database";

export function useMeetings() {
  const { meetings, setMeetings, removeMeeting } = useMeetingStore();

  useEffect(() => {
    loadMeetings();
  }, []);

  const loadMeetings = useCallback(async () => {
    try {
      const data = await getMeetings();
      setMeetings(data);
    } catch (e) {
      console.error("미팅 목록 로드 실패:", e);
    }
  }, [setMeetings]);

  const deleteAudioFile = useCallback(async (audioPath: string) => {
    try {
      await invoke("delete_audio_file", { audioPath });
    } catch (e) {
      console.error("오디오 파일 삭제 실패:", e);
    }
  }, []);

  const deleteMeeting = useCallback(
    async (id: string, audioPath: string, deleteAudio = true) => {
      if (deleteAudio) {
        await deleteAudioFile(audioPath);
      }
      await dbDeleteMeeting(id);
      removeMeeting(id);
    },
    [deleteAudioFile, removeMeeting]
  );

  return { meetings, loadMeetings, deleteMeeting, deleteAudioFile };
}
