import { createParamDecorator, ExecutionContext } from '@nestjs/common';
import { GqlExecutionContext } from '@nestjs/graphql';

export const CurrentUser = createParamDecorator(
  (data: string, ctx: ExecutionContext) => {
    // GraphQL resolvers receive (root, args, context, info) — the request
    // lives on the GraphQL context rather than the first handler argument.
    const request =
      ctx.getType<string>() === 'graphql'
        ? GqlExecutionContext.create(ctx).getContext().req
        : ctx.switchToHttp().getRequest();
    const user = request?.user;
    return data ? user?.[data] : user;
  },
);
