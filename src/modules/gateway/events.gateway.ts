import {
  WebSocketGateway, WebSocketServer, SubscribeMessage,
  OnGatewayConnection, OnGatewayDisconnect,
  MessageBody, ConnectedSocket,
} from "@nestjs/websockets";
import { Server, Socket } from "socket.io";

@WebSocketGateway({
  cors: { origin: "*", credentials: false },
  path: "/ws",
  namespace: "/ws",
  pingInterval: 25000,
  pingTimeout: 60000,
})
export class EventsGateway implements OnGatewayConnection, OnGatewayDisconnect {
  @WebSocketServer()
  server: Server;

  private clientRooms = new Map<string, Set<string>>();

  handleConnection(client: Socket) {
    this.clientRooms.set(client.id, new Set());
  }

  handleDisconnect(client: Socket) {
    this.clientRooms.delete(client.id);
  }

  // ── Subscribe to a specific video room ───────────────────────────────────
  @SubscribeMessage("subscribe:video")
  handleSubscribeVideo(@MessageBody() videoId: string, @ConnectedSocket() client: Socket) {
    const room = `video:${videoId}`;
    client.join(room);
    this.clientRooms.get(client.id)?.add(room);
    return { event: "subscribed", data: videoId };
  }

  @SubscribeMessage("unsubscribe:video")
  handleUnsubscribeVideo(@MessageBody() videoId: string, @ConnectedSocket() client: Socket) {
    const room = `video:${videoId}`;
    client.leave(room);
    this.clientRooms.get(client.id)?.delete(room);
  }

  // ── Subscribe to project-wide events (all videos in a project) ───────────
  @SubscribeMessage("subscribe:project")
  handleSubscribeProject(@MessageBody() projectId: string, @ConnectedSocket() client: Socket) {
    const room = `project:${projectId}`;
    client.join(room);
    this.clientRooms.get(client.id)?.add(room);
    return { event: "subscribed:project", data: projectId };
  }

  @SubscribeMessage("unsubscribe:project")
  handleUnsubscribeProject(@MessageBody() projectId: string, @ConnectedSocket() client: Socket) {
    client.leave(`project:${projectId}`);
    this.clientRooms.get(client.id)?.delete(`project:${projectId}`);
  }

  // ── Emit helpers ──────────────────────────────────────────────────────────

  emitVideoProgress(videoId: string, progress: number, stage: string) {
    this.server.to(`video:${videoId}`).emit("video:progress", {
      videoId, progress, stage, timestamp: Date.now(),
    });
  }

  emitVideoStatusChange(videoId: string, status: {
    transcript_status?: string;
    analysis_status?: string;
    analysis_result?: any;
  }) {
    this.server.to(`video:${videoId}`).emit("video:status", {
      videoId, ...status, timestamp: Date.now(),
    });
  }

  emitVideoError(videoId: string, error: string) {
    this.server.to(`video:${videoId}`).emit("video:error", {
      videoId, error, timestamp: Date.now(),
    });
  }

  emitClipReady(videoId: string, clip: any) {
    this.server.to(`video:${videoId}`).emit("clip:ready", {
      videoId, clip, timestamp: Date.now(),
    });
  }

  emitClipExportProgress(clipId: string, videoId: string, progress: number) {
    this.server.to(`video:${videoId}`).emit("clip:export-progress", {
      clipId, videoId, progress, timestamp: Date.now(),
    });
  }

  emitClipExportError(clipId: string, videoId: string, error: string) {
    this.server.to(`video:${videoId}`).emit("clip:export-error", {
      clipId, videoId, error, timestamp: Date.now(),
    });
  }

  // Notify all subscribers of a project when a new video is added/updated
  emitProjectUpdate(projectId: string, event: string, data: any) {
    this.server.to(`project:${projectId}`).emit(event, {
      projectId, ...data, timestamp: Date.now(),
    });
  }
}
