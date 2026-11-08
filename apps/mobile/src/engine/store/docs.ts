/**
 * Almacenamiento local de documentos JSON y de imágenes. En el teléfono es IndexedDB (no hay servidor ni nube);
 * en las pruebas, una implementación en memoria con la misma interfaz.
 */
export interface DocStorage {
  getDoc<T>(key: string): Promise<T | undefined>;
  putDoc(key: string, value: unknown): Promise<void>;
  deleteDoc(key: string): Promise<void>;
  listDocKeys(prefix: string): Promise<string[]>;
  getBlob(key: string): Promise<Blob | undefined>;
  putBlob(key: string, blob: Blob): Promise<void>;
  deleteBlob(key: string): Promise<void>;
  /** Borra todos los documentos e imágenes cuyo nombre empieza por el prefijo. */
  deleteByPrefix(prefix: string): Promise<void>;
  /** Bytes ocupados por las imágenes con ese prefijo. */
  blobBytes(prefix: string): Promise<number>;
}

interface StoredBlob { type: string; data: ArrayBuffer }

async function pack(blob: Blob): Promise<StoredBlob> {
  return { type: blob.type, data: await blob.arrayBuffer() };
}
const unpack = (s: StoredBlob): Blob => new Blob([s.data], { type: s.type });

export class MemoryStorage implements DocStorage {
  private docs = new Map<string, string>();
  private blobs = new Map<string, StoredBlob>();

  async getDoc<T>(key: string): Promise<T | undefined> {
    const raw = this.docs.get(key);
    return raw === undefined ? undefined : JSON.parse(raw) as T;
  }
  async putDoc(key: string, value: unknown): Promise<void> { this.docs.set(key, JSON.stringify(value)); }
  async deleteDoc(key: string): Promise<void> { this.docs.delete(key); }
  async listDocKeys(prefix: string): Promise<string[]> { return [...this.docs.keys()].filter((k) => k.startsWith(prefix)).sort(); }
  async getBlob(key: string): Promise<Blob | undefined> {
    const b = this.blobs.get(key);
    return b && unpack(b);
  }
  async putBlob(key: string, blob: Blob): Promise<void> { this.blobs.set(key, await pack(blob)); }
  async deleteBlob(key: string): Promise<void> { this.blobs.delete(key); }
  async deleteByPrefix(prefix: string): Promise<void> {
    for (const k of [...this.docs.keys()]) if (k.startsWith(prefix)) this.docs.delete(k);
    for (const k of [...this.blobs.keys()]) if (k.startsWith(prefix)) this.blobs.delete(k);
  }
  async blobBytes(prefix: string): Promise<number> {
    let n = 0;
    for (const [k, v] of this.blobs) if (k.startsWith(prefix)) n += v.data.byteLength;
    return n;
  }
}

const DB_NAME = 'starblitz-engine';
const DB_VERSION = 1;

function req<T>(r: IDBRequest<T>): Promise<T> {
  return new Promise((resolve, reject) => {
    r.onsuccess = () => resolve(r.result);
    r.onerror = () => reject(r.error ?? new Error('Error de almacenamiento'));
  });
}

function done(tx: IDBTransaction): Promise<void> {
  return new Promise((resolve, reject) => {
    tx.oncomplete = () => resolve();
    tx.onerror = () => reject(tx.error ?? new Error('Error de almacenamiento'));
    tx.onabort = () => reject(tx.error ?? new Error('Transacción cancelada'));
  });
}

const range = (prefix: string) => IDBKeyRange.bound(prefix, prefix + '￿');

export class IdbStorage implements DocStorage {
  private db: Promise<IDBDatabase>;

  constructor(name = DB_NAME, factory: IDBFactory = indexedDB) {
    this.db = new Promise((resolve, reject) => {
      const open = factory.open(name, DB_VERSION);
      open.onupgradeneeded = () => {
        const db = open.result;
        if (!db.objectStoreNames.contains('docs')) db.createObjectStore('docs');
        if (!db.objectStoreNames.contains('blobs')) db.createObjectStore('blobs');
      };
      open.onsuccess = () => resolve(open.result);
      open.onerror = () => reject(open.error ?? new Error('No se pudo abrir el almacenamiento local'));
    });
  }

  private async store(name: 'docs' | 'blobs', mode: IDBTransactionMode) {
    const tx = (await this.db).transaction(name, mode);
    return { tx, os: tx.objectStore(name) };
  }

  async getDoc<T>(key: string): Promise<T | undefined> {
    const { os } = await this.store('docs', 'readonly');
    return (await req(os.get(key))) as T | undefined;
  }
  async putDoc(key: string, value: unknown): Promise<void> {
    const { tx, os } = await this.store('docs', 'readwrite');
    os.put(JSON.parse(JSON.stringify(value)), key);
    await done(tx);
  }
  async deleteDoc(key: string): Promise<void> {
    const { tx, os } = await this.store('docs', 'readwrite');
    os.delete(key);
    await done(tx);
  }
  async listDocKeys(prefix: string): Promise<string[]> {
    const { os } = await this.store('docs', 'readonly');
    return (await req(os.getAllKeys(range(prefix)))) as string[];
  }
  async getBlob(key: string): Promise<Blob | undefined> {
    const { os } = await this.store('blobs', 'readonly');
    const v = (await req(os.get(key))) as StoredBlob | undefined;
    return v && unpack(v);
  }
  async putBlob(key: string, blob: Blob): Promise<void> {
    const packed = await pack(blob); // se lee antes de abrir la transacción (IndexedDB se cierra si hay esperas ajenas)
    const { tx, os } = await this.store('blobs', 'readwrite');
    os.put(packed, key);
    await done(tx);
  }
  async deleteBlob(key: string): Promise<void> {
    const { tx, os } = await this.store('blobs', 'readwrite');
    os.delete(key);
    await done(tx);
  }
  async deleteByPrefix(prefix: string): Promise<void> {
    const db = await this.db;
    const tx = db.transaction(['docs', 'blobs'], 'readwrite');
    tx.objectStore('docs').delete(range(prefix));
    tx.objectStore('blobs').delete(range(prefix));
    await done(tx);
  }
  async blobBytes(prefix: string): Promise<number> {
    const { os } = await this.store('blobs', 'readonly');
    const all = (await req(os.getAll(range(prefix)))) as StoredBlob[];
    return all.reduce((n, b) => n + b.data.byteLength, 0);
  }
}
