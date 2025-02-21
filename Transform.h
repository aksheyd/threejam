#ifndef TRANSFORM_H
#define TRANSFORM_H

#include <iostream>
#include "./Bin/Include/glm/glm.hpp"
#include "./Bin/Include/glm/gtc/type_ptr.hpp"
#include "Component.h"


class Transform : public Component
{
	glm::vec3 _position;
public:
	void SetPosition(const glm::vec3& new_position) 
	{
		_position = new_position;
	}

	glm::vec3 GetPosition() {
		return _position;
	}
};

#endif
