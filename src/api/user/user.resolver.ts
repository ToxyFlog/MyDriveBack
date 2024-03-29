import {UserModel} from "./user.model";
import {Args, Mutation, Query, Resolver} from "@nestjs/graphql";
import {UserService} from "./user.service";
import {HashService} from "../../services/hash.service";
import {AuthenticationArgs} from "./dto/authentication.args";
import {TokenService} from "../../services/token.service";
import {AuthenticationReturn} from "./dto/authentication.return";
import {AuthenticationMiddleware} from "../../middleware/authentication/authentication.middleware";
import {UseMiddlewares} from "../../middleware/interceptorAsMiddleware";
import {MiddlewareData} from "../../middleware/middlewareDataDecorator";
import {UsernameToId} from "./dto/usernameToId";

@Resolver(of => UserModel)
export class UserResolver {
	constructor(
		private userService: UserService,
		private hashService: HashService,
		private tokenService: TokenService,
	) {}

	@Query(returns => UserModel, {nullable: true})
	@UseMiddlewares(AuthenticationMiddleware)
	async user(
		@Args("username", {type: () => String, nullable: true}) username: string | null,
		@MiddlewareData() user: { username: string },
	): Promise<UserModel | null> {
		return await this.userService.getUser(username || user.username);
	}

	@Query(returns => [UsernameToId], {nullable: true})
	async users(
		@Args("usernames", {type: () => [String]}) usernames: string[],
	): Promise<UsernameToId[]> {
		return await this.userService.getUsersByUsernames(usernames);
	}

	@Query(returns => [UsernameToId], {nullable: true})
	async usernames(
		@Args("user_ids", {type: () => [Number]}) user_ids: number[],
	): Promise<UsernameToId[]> {
		return await this.userService.getUsersByIds(user_ids);
	}

	@Query(returns => Boolean)
	async doesUserExist(
		@Args("username", {type: () => String}) username: string,
	): Promise<boolean> {
		return !!(await this.userService.getUser(username));
	}


	@Mutation(returns => AuthenticationReturn)
	async login(
		@Args({type: () => AuthenticationArgs}) {username, password}: AuthenticationArgs,
	): Promise<{ token: string } | { error: string }> {
		const user: UserModel | null = await this.userService.getUser(username);
		if (user === null) return {error: "Incorrect username and/or password!"};
		const {id, drive_id, bin_id} = user;

		const isPasswordCorrect = await this.hashService.compare(user.password, password);
		if (!isPasswordCorrect) return {error: "Incorrect username and/or password!"};

		const token = await this.tokenService.generateJWT({username, id, drive_id, bin_id});
		return {token};
	}

	@Mutation(returns => AuthenticationReturn)
	async signup(
		@Args({type: () => AuthenticationArgs}) {username, password}: AuthenticationArgs,
	): Promise<{ token: string } | { error: string }> {
		const existingUser: UserModel | null = await this.userService.getUser(username);
		if (existingUser !== null) return {error: "This username is already taken!"};

		const hashedPassword = await this.hashService.hash(password);
		const {id, drive_id, bin_id} = await this.userService.createUser({username, password: hashedPassword});

		const token = await this.tokenService.generateJWT({username, id, drive_id, bin_id});
		return {token};
	}
}