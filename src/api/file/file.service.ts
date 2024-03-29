import {Injectable} from "@nestjs/common";
import {DBService} from "../../services/db.service";
import {FileModel} from "./file.model";
import {SimpleFileEntryInput} from "./dto/uploadFiles.args";
import {FileEntry} from "./dto/uploadFilesAndFolders.args";
import {UserService} from "../user/user.service";
import {MoveEntriesEntry} from "./dto/moveEntries.args";
import {SharePolicies} from "./dto/shareEntries.args";

@Injectable()
export class FileService {
	constructor(
		private DBService: DBService,
		private userService: UserService,
	) {}

	async getEntry(entry_id: number, user_id?: number): Promise<FileModel | null> {
		const [entry] = await this.DBService.query(`
			select f.*, s.can_edit_users, (to_json(b)::jsonb - 'id') as bin_data from files as f 
			left join share as s on f.share_id = s.id
			left join bin as b on f.id = b.id
			where f.id = $1;
		`, [entry_id]) as [any];
		if (!entry) return null;

		const can_edit: boolean = user_id ? entry.owner_id === user_id || (entry.can_edit_users || []).includes(user_id) : false;
		return {...entry, can_edit} as FileModel;
	}

	async getEntries(parent_id: number, user_id: number, recursively = false): Promise<FileModel[]> {
		const result = recursively ?
			await this.DBService.query(`
				with recursive recfiles as (
				  select f.* from files as f
					where id = $1 and is_directory = true
				  union
				  select f.* from files as f
					inner join recfiles r on f.parent_id = r.id
				) select r.*, s.can_edit_users, (to_json(b)::jsonb - 'id') as bin_data from recfiles as r
				left join share as s on r.share_id = s.id
				left join bin as b on r.id = b.id;
			`, [parent_id]) :
			await this.DBService.query(`
				select f.*, s.can_edit_users, (to_json(b)::jsonb - 'id') as bin_data from files as f
				left join share as s on f.share_id = s.id
				left join bin as b on f.id = b.id
				where parent_id = $1;
			`, [parent_id]);
		if (!result) return [];

		return result.map((entry: any) => ({...entry, can_edit: entry.owner_id === user_id || (entry.can_edit_users || []).includes(user_id)})) as FileModel[];
	}

	async getFolders(parent_id: number): Promise<FileModel[]> {
		return await this.DBService.query("select * from files where parent_id = $1 and is_directory = true;", [parent_id]) as FileModel[];
	}

	async getFoldersInFolderRecursively(parent_id: number): Promise<FileModel[]> {
		return await this.DBService.query(`
			with recursive directories as (
			  select f.id, f.parent_id, f.name from files f
				where parent_id = $1 and is_directory = true
			  union
			  select f.id, f.parent_id, f.name from files f
				inner join directories d on f.parent_id = d.id
				where  is_directory = true
			) select * from directories;
		`, [parent_id]) as FileModel[];
	}

	async getSharedFolders(user_id: number): Promise<FileModel[]> {
		const result = await this.DBService.query(`
			with s as (
			  select id, can_edit_users from share as s where s.can_read_users @> $1
			)
			select f.*, can_edit_users from files as f
			inner join s on s.id = f.share_id
			where is_directory = true;
		`, [[user_id]]) as FileModel[];

		return result.map((entry: any) => ({...entry, can_edit: entry.can_edit_users.includes(user_id)})) as FileModel[];
	}

	async getSharedFoldersAndOwnerUsernames(user_id: number): Promise<FileModel[]> {
		const result = await this.DBService.query(`
			with s as (
			  select id, can_edit_users from share as s where s.can_read_users @> $1
			) select f.*, can_edit_users, username from files as f
			inner join users as u on f.owner_id = u.id
			inner join s on f.share_id = s.id
			where is_directory = true;
		`, [[user_id]]) as FileModel[];

		return result.map((entry: any) => ({...entry, can_edit: entry.can_edit_users.includes(user_id)})) as FileModel[];
	}

	async getUsernamesWhoShareWithUser(user_id: number): Promise<string[]> {
		const result = await this.DBService.query(`
			with s as (
			  select array_agg(id) ids from share as s where s.can_read_users @> $1
			) 
			select username from s, files as f 
			join users as u on f.owner_id = u.id
			where is_directory = true and share_id = any(s.ids);
		`, [[user_id]]) as { username: string }[];

		return result.map(({username}) => username);
	}

	async getUsersSharedEntries(user_id: number, username: string): Promise<FileModel[]> {
		const result = await this.DBService.query(`
			with s as (
			  select id, can_edit_users from share as s where s.can_read_users @> $1
			), f as (
			  select f.*, s.can_edit_users from files as f
			  inner join users as u on f.owner_id = u.id
			  inner join s on s.id = f.share_id
			  where username = $2
			)
			select f.* from f
			join files as p on f.parent_id = p.id
			where p.share_id is null or p.share_id != f.share_id;
		`, [[user_id], username]);

		return result.map((entry: any) => ({...entry, can_edit: entry.can_edit_users.includes(user_id)})) as FileModel[];
	}


	async getSharePolicy(entry_id: number): Promise<SharePolicies | null> {
		const [result] = await this.DBService.query(`select s.* from files as f right join share as s on f.share_id = s.id where f.id = $1;`, [entry_id]) as [SharePolicies?];
		return result || null;
	}

	async getSharePolicyForUser(entry_id: number, user_id: number): Promise<{ canEdit: boolean } | null> {
		const [result] = await this.DBService.query(`
			with f as (
			  select * from files where id = $1
			)
			select s.* from share as s, f
			where s.id = f.share_id;
		`, [entry_id]) as [{ can_edit_users: number[], can_read_users: number[] }?];
		if (!result) return null;

		const {can_edit_users, can_read_users} = result;
		if (can_edit_users.includes(user_id)) return {canEdit: true};
		if (can_read_users.includes(user_id)) return {canEdit: false};

		return null;
	}

	async hasAccess(user_id: number, parent_id: number): Promise<{ canEdit: boolean } | null> {
		const entry = await this.getEntry(parent_id, user_id);
		if (entry === null) return null;
		if (entry.owner_id === user_id) return {canEdit: true};

		return await this.getSharePolicyForUser(entry.id, user_id);
	}

	isImage(filename: string): boolean {
		const extensions = [".jpg", ".jpeg", ".png"];
		return extensions.reduce((res, extension) => res ? true : filename.endsWith(extension), false);
	}

	async isInBin(entry_id: number): Promise<boolean> {
		const [result] = await this.DBService.query(`select count(1) from bin where id = $1;`, [entry_id]) as [{ count: string }?];
		return result ? result.count === "1" : false;
	}

	async doFilesCollide(names: string[], parent_id: number, is_directory: boolean): Promise<boolean> {
		const result = await this.DBService.query("select count(1) from files where parent_id = $1 and is_directory = $2 and name = any($3)", [parent_id, is_directory, names]) as [{ count: number }?];
		if (result.length === 0) return true;

		const count = Number(result[0].count);
		if (isNaN(count)) return true;
		return count !== 0;
	}

	async canUpload(owner_id: number, parent_id: number, topLevelEntries: FileEntry[], size: number): Promise<boolean> {
		const permissions = await this.hasAccess(owner_id, parent_id);
		if (permissions === null || permissions.canEdit === false) return false;

		const free_space = await this.userService.getFreeSpace(owner_id);
		if (size > free_space) return false;

		if (topLevelEntries[0].is_directory !== undefined) {
			const fileNames = topLevelEntries.map(entry => !entry.is_directory ? entry.newName || entry.name : null).filter(entry => entry !== null);
			const hasFileCollisions = await this.doFilesCollide(fileNames, parent_id, false);
			const folderNames = topLevelEntries.map(entry => entry.is_directory ? entry.newName || entry.name : null).filter(entry => entry !== null);
			const hasFolderCollisions = await this.doFilesCollide(folderNames, parent_id, true);
			if (hasFileCollisions || hasFolderCollisions) return false;
		} else {
			const names = topLevelEntries.map(entry => entry.newName || entry.name);
			const hasFileCollisions = await this.doFilesCollide(names, parent_id, false);
			if (hasFileCollisions) return false;
		}

		return true;
	}


	async uploadFiles(entries: SimpleFileEntryInput[], owner_id: number, parent_id: number): Promise<Map<string, [number, number]> | null> {
		const file = await this.getEntry(parent_id);
		const share_id = file ? file.share_id : null;

		const statement = "insert into files(owner_id, parent_id, share_id, is_directory, size, name) values($1, $2, $3, false, $4, $5) returning name, id;";
		const queries: [string, any[]][] = entries.map(entry => [statement, [owner_id, parent_id, share_id, entry.size, entry.newName || entry.name]]);
		const result = await this.DBService.transaction(queries) as [{ name: string, id: number }][];

		const map = new Map<string, [number, number]>();
		result.forEach(result => map.set(result[0].name, [result[0].id, parent_id]));

		return map;
	}

	async uploadFilesAndFolders(entries: FileEntry[], owner_id: number, parent_id: number): Promise<Map<string, [number, number]> | null> {
		const statement = "insert into files(owner_id, parent_id, share_id, size, name, is_directory) values($1, $2, $3, $4, $5, $6) returning id;";
		const pathToId = new Map<string, [number, number]>();
		pathToId.set("", [parent_id, parent_id]);

		const parent = await this.getEntry(parent_id);
		const share_id = parent ? parent.share_id : null;

		await this.DBService.query("begin;");
		let isError = false;
		for (let i = 0; i < entries.length; i++) {
			const {size, name, newName, path, is_directory} = entries[i];
			const parent_id = path === null ? null : pathToId.get(path)[0];

			const res = await this.DBService.query(statement, [owner_id, parent_id, share_id, size, newName || name, is_directory]) as [{ id: number }];
			if (res === null) {
				await this.DBService.query("rollback;");
				isError = true;
				break;
			}

			const key = path ? `${path}/${name}` : name;
			const id = res[0].id;
			pathToId.set(key, [id, parent_id]);
		}
		if (!isError) await this.DBService.query("commit;");

		return isError ? null : pathToId;
	}

	async createFolder(parent_id: number, user_id: number, name: string): Promise<number | null> {
		const entry = await this.getEntry(parent_id);
		const share_id = entry ? entry.share_id : null;

		const [{id}] = await this.DBService.query("insert into files(owner_id, parent_id, share_id, is_directory, size, name) values ($1, $2, $3, true, 0, $4) returning id;", [user_id, parent_id, share_id, name]) as [{ id: number }];
		return id || null;
	}


	async shareEntries(entry_id: number, policies: { can_read_users: number[], can_edit_users: number[] }) {
		const {can_read_users, can_edit_users} = policies;
		can_edit_users.forEach(id => {
			if (can_read_users.includes(id)) return;
			can_read_users.push(id);
		});

		const entry = await this.getEntry(entry_id);
		const parent = await this.getEntry(entry.parent_id);

		if (entry.share_id !== null && parent.share_id !== entry.share_id) {
			await this.DBService.query(`update share set can_read_users = $1, can_edit_users = $2 where id = $3;`, [can_read_users, can_edit_users, entry.share_id]);
		} else {
			const [{id: share_id}] = await this.DBService.query(`insert into share(can_edit_users, can_read_users) values($1, $2) returning id;`, [can_edit_users, can_read_users]) as [{ id: number }];

			await this.DBService.query(`
				with recursive directories as (
				  select * from files where id = $1
				  union
				  select f.* from files as f
				  join directories d
				  on d.id = f.parent_id
				  where d.share_id = $2 or d.share_id is null
				) 
				update files as f set share_id = $3 from directories as d
				where f.id = d.id;
			`, [entry_id, entry.share_id, share_id]);
		}
	}

	async moveEntries(entries: MoveEntriesEntry[], parent_id: number, resetShareId = false) {
		const [ids, parent_ids, names] = entries.reduce(([a1, a2, a3], {id, parent_id, name}) => [[...a1, id], [...a2, parent_id], [...a3, name]], [[], [], []]);

		if (resetShareId) {
			await this.DBService.query(`
			with data as (
			  select unnest($1::int[]) as id, unnest($2::int[]) as parent_id, unnest($3::varchar[]) as name
			)
			update files as f set parent_id = $4, name = d.name, share_id = null from data as d
			where f.parent_id = d.parent_id and f.id = d.id;
		`, [ids as number[], parent_ids as number[], names as string[], parent_id]);
			return;
		}

		await this.DBService.query(`
			with data as (
			  select unnest($1::int[]) as id, unnest($2::int[]) as parent_id, unnest($3::varchar[]) as name
			)
			update files as f set parent_id = $4, name = d.name from data as d
			where f.parent_id = d.parent_id and f.id = d.id;
		`, [ids as number[], parent_ids as number[], names as string[], parent_id]);
	}

	async changeOwnerRecursively(entries: FileModel[], owner_id: number, prev_owner_id: number) {
		const entry_ids = entries.map(entry => entry.id);
		await this.DBService.query(`
			with recursive entries as (
			  select f.* from files as f
			  where id = any($1)
			  union
			  select f.* from files as f
			  inner join entries e on f.parent_id = e.id
			)
			update files as f set owner_id = $2 from entries as e where f.id = e.id;
		`, [entry_ids, owner_id]);

		const size = entries.reduce((sum, cur) => sum + cur.size, 0);
		await this.userService.increaseUsedSpace(owner_id, size);
		await this.userService.decreaseUsedSpace(prev_owner_id, size);
	}

	async renameEntry(entry_id: number, newFilename: string) {
		await this.DBService.query(`update files set name = $1 where id = $2;`, [newFilename, entry_id]);
	}

	async addEntryToBin(entry_id: number, parent_id: number, share_id: number | null) {
		await this.DBService.query(`insert into bin(id, prev_parent_id, prev_share_id) values($1, $2, $3);`, [entry_id, parent_id, share_id]);
	}

	async setShareId(entry_id: number, share_id: number) {
		await this.DBService.query(`update files set share_id = $1 where id = $2;`, [share_id, entry_id]);
	}

	async removeEntriesFromBin(entry_ids: number[]) {
		await this.DBService.query(`delete from bin where id = any($1);`, [entry_ids]);
	}

	async deleteExpiredEntries() {
		const entries = await this.DBService.query(`
			select f.* from bin as b 
			join files as f on b.id = f.id 
			where b.put_at < (round(extract(epoch from now()) * 1000) - 3 * 24 * 60 * 60 * 1000);
		`, []) as FileModel[];

		const ids: number[] = entries.map(entry => entry.id);
		await this.DBService.query(`delete from bin where id = any($1::int[]);`, [ids]);
		await this.DBService.query(`delete from files where id = any($1::int[]);`, [ids]);

		const userToSpace: { [key: number]: number } = {};
		entries.forEach(({owner_id, size}) => {
			if (!userToSpace[owner_id]) userToSpace[owner_id] = 0;
			userToSpace[owner_id] += size;
		});
		Object.entries(userToSpace).forEach(([user_id, space]) => this.userService.decreaseUsedSpace(Number(user_id), space));

		await this.DBService.query(`
			with c as (
			  select (count(1) - 1) as count, s.id from share as s
			  left join files as f on f.share_id = s.id
			  group by s.id
			) 
			delete from share as s
			where (select count from c where c.id = s.id) = 0;
		`);
	}

	async fullyDeleteEntries(entry_ids: number[]) {
		await this.DBService.query(`delete from bin where id = any($1);`, [entry_ids]);
		await this.DBService.query(`delete from files where id = any($1);`, [entry_ids]);
	}
}