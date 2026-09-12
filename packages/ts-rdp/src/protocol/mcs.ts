/**
 * MCS-Schicht (T.125) - Domain-Aufbau, Kanalbeitritt und Datenrahmen.
 *
 * Die Connect-PDUs sind BER-kodiert, alles danach PER. Diese Asymmetrie ist
 * nicht schoen, stammt aber direkt aus T.125.
 */
import { BinaryReader, writer } from '../core/binary.js';
import { RdpProtocolError } from '../core/errors.js';
import * as ber from './ber.js';
import * as per from './per.js';
import { MCS_USERCHANNEL_BASE } from './constants.js';

/** PDU-Typen der MCS-Domain (obere 6 Bit des ersten Bytes). */
export const enum DomainPdu {
  ErectDomainRequest = 1,
  DisconnectProviderUltimatum = 8,
  AttachUserRequest = 10,
  AttachUserConfirm = 11,
  ChannelJoinRequest = 14,
  ChannelJoinConfirm = 15,
  SendDataRequest = 25,
  SendDataIndication = 26,
}

interface DomainParameters {
  maxChannelIds: number;
  maxUserIds: number;
  maxTokenIds: number;
  numPriorities: number;
  minThroughput: number;
  maxHeight: number;
  maxMcsPduSize: number;
  protocolVersion: number;
}

function domainParameters(p: DomainParameters): Buffer {
  return ber.writeSequence(
    ber.writeInteger(p.maxChannelIds),
    ber.writeInteger(p.maxUserIds),
    ber.writeInteger(p.maxTokenIds),
    ber.writeInteger(p.numPriorities),
    ber.writeInteger(p.minThroughput),
    ber.writeInteger(p.maxHeight),
    ber.writeInteger(p.maxMcsPduSize),
    ber.writeInteger(p.protocolVersion),
  );
}

const TARGET_PARAMS: DomainParameters = {
  maxChannelIds: 34,
  maxUserIds: 2,
  maxTokenIds: 0,
  numPriorities: 1,
  minThroughput: 0,
  maxHeight: 1,
  maxMcsPduSize: 0xffff,
  protocolVersion: 2,
};

const MIN_PARAMS: DomainParameters = {
  maxChannelIds: 1,
  maxUserIds: 1,
  maxTokenIds: 1,
  numPriorities: 1,
  minThroughput: 0,
  maxHeight: 1,
  maxMcsPduSize: 0x420,
  protocolVersion: 2,
};

const MAX_PARAMS: DomainParameters = {
  maxChannelIds: 0xffff,
  maxUserIds: 0xfc17,
  maxTokenIds: 0xffff,
  numPriorities: 1,
  minThroughput: 0,
  maxHeight: 1,
  maxMcsPduSize: 0xffff,
  protocolVersion: 2,
};

export function buildConnectInitial(userData: Buffer): Buffer {
  return ber.wrapApplication(
    101,
    ber.writeOctetString(Buffer.from([1])), // callingDomainSelector
    ber.writeOctetString(Buffer.from([1])), // calledDomainSelector
    ber.writeBoolean(true), // upwardFlag
    domainParameters(TARGET_PARAMS),
    domainParameters(MIN_PARAMS),
    domainParameters(MAX_PARAMS),
    ber.writeOctetString(userData),
  );
}

/** Liefert die GCC-Nutzdaten aus dem Connect Response PDU. */
export function parseConnectResponse(payload: Buffer): Buffer {
  const r = new BinaryReader(payload);
  ber.readApplicationTag(r, 102);
  const result = ber.readEnumerated(r);
  if (result !== 0) throw new RdpProtocolError(`MCS: Connect Response mit Ergebnis ${result} (0 = erfolgreich)`);
  ber.readInteger(r); // calledConnectId
  const paramLength = ber.readUniversalTag(r, ber.BER_SEQUENCE, true);
  r.skip(paramLength); // ausgehandelte DomainParameters interessieren uns nicht
  return ber.readOctetString(r);
}

export function buildErectDomainRequest(): Buffer {
  return Buffer.concat([
    per.writeChoice(DomainPdu.ErectDomainRequest << 2),
    per.writeInteger(0), // subHeight
    per.writeInteger(0), // subInterval
  ]);
}

export function buildAttachUserRequest(): Buffer {
  return per.writeChoice(DomainPdu.AttachUserRequest << 2);
}

export function parseAttachUserConfirm(payload: Buffer): number {
  const r = new BinaryReader(payload);
  const opcode = per.readChoice(r);
  if (opcode >> 2 !== DomainPdu.AttachUserConfirm) {
    throw new RdpProtocolError(`MCS: erwartet wurde AttachUserConfirm, gelesen Opcode ${opcode >> 2}`);
  }
  const result = per.readEnumerates(r);
  if (result !== 0) throw new RdpProtocolError(`MCS: AttachUserConfirm mit Ergebnis ${result}`);
  if (!(opcode & 2)) throw new RdpProtocolError('MCS: AttachUserConfirm ohne Initiator-Feld');
  return per.readInteger16(r, MCS_USERCHANNEL_BASE);
}

export function buildChannelJoinRequest(userId: number, channelId: number): Buffer {
  return Buffer.concat([
    per.writeChoice(DomainPdu.ChannelJoinRequest << 2),
    per.writeInteger16(userId, MCS_USERCHANNEL_BASE),
    per.writeInteger16(channelId),
  ]);
}

export function parseChannelJoinConfirm(payload: Buffer): { userId: number; channelId: number } {
  const r = new BinaryReader(payload);
  const opcode = per.readChoice(r);
  if (opcode >> 2 !== DomainPdu.ChannelJoinConfirm) {
    throw new RdpProtocolError(`MCS: erwartet wurde ChannelJoinConfirm, gelesen Opcode ${opcode >> 2}`);
  }
  const result = per.readEnumerates(r);
  if (result !== 0) throw new RdpProtocolError(`MCS: Kanalbeitritt abgelehnt (Ergebnis ${result})`);
  const userId = per.readInteger16(r, MCS_USERCHANNEL_BASE);
  per.readInteger16(r); // requested
  const channelId = per.readInteger16(r);
  return { userId, channelId };
}

function buildSendData(opcode: DomainPdu, userId: number, channelId: number, data: Buffer): Buffer {
  return Buffer.concat([
    per.writeChoice(opcode << 2),
    per.writeInteger16(userId, MCS_USERCHANNEL_BASE),
    per.writeInteger16(channelId),
    Buffer.from([0x70]), // dataPriority = high, segmentation = begin|end
    per.writeLength(data.length),
    data,
  ]);
}

export function buildSendDataRequest(userId: number, channelId: number, data: Buffer): Buffer {
  return buildSendData(DomainPdu.SendDataRequest, userId, channelId, data);
}

/** Gegenrichtung (Server -> Client); wird von der Testgegenstelle genutzt. */
export function buildSendDataIndication(userId: number, channelId: number, data: Buffer): Buffer {
  return buildSendData(DomainPdu.SendDataIndication, userId, channelId, data);
}

export interface SendDataIndication {
  userId: number;
  channelId: number;
  payload: Buffer;
}

/**
 * Liest ein SendDataIndication. Ein DisconnectProviderUltimatum wird als
 * `undefined` signalisiert - das ist die regulaere Abmeldung des Servers.
 */
export function parseSendDataIndication(payload: Buffer): SendDataIndication | undefined {
  return parseSendData(payload, DomainPdu.SendDataIndication);
}

/** Wie oben, aber fuer die Serverseite: dort kommen SendDataRequests an. */
export function parseSendDataRequest(payload: Buffer): SendDataIndication | undefined {
  return parseSendData(payload, DomainPdu.SendDataRequest);
}

function parseSendData(payload: Buffer, expected: DomainPdu): SendDataIndication | undefined {
  const r = new BinaryReader(payload);
  const opcode = per.readChoice(r);
  const pduType = opcode >> 2;
  if (pduType === DomainPdu.DisconnectProviderUltimatum) return undefined;
  if (pduType !== expected) {
    throw new RdpProtocolError(`MCS: unerwarteter Domain-PDU-Typ ${pduType}`);
  }
  const userId = per.readInteger16(r, MCS_USERCHANNEL_BASE);
  const channelId = per.readInteger16(r);
  r.uint8(); // dataPriority/segmentation
  const length = per.readLength(r);
  return { userId, channelId, payload: r.bytes(Math.min(length, r.remaining)) };
}

export { writer };
